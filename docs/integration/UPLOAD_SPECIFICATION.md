# Upload specification: member files

Internal technical specification of the member-file pipeline. The external, HMO-facing description is in [HMO_INTEGRATION_GUIDE.md](HMO_INTEGRATION_GUIDE.md).

| Stage | Code |
|---|---|
| Receive | `src/lib/server/api/router.ts` (`POST /v1/imports`), `api/http.ts#readBodyCapped` |
| Inspect | `src/lib/server/uploads/file-guard.ts` |
| Scan | `src/lib/server/uploads/scanner.ts` |
| Parse | `src/lib/server/connectors/tabular.ts` |
| Analyse, stage, apply | `src/lib/server/services/imports.ts` |
| Apply records | `src/lib/server/services/member-sync.ts` |
| Queue | `src/lib/server/jobs/queue.ts`, `scripts/worker.ts` |

## 1. Pipeline

| # | Stage | Behaviour | Failure |
|---|---|---|---|
| 1 | Receive | Body read as a stream with a hard cap of `IMPORT_MAX_BYTES` + 256 KiB, checked against Content-Length first and then while reading, **before** multipart parsing. Rate limit: 60 uploads per HMO per hour. Requires `imports:manage` in an HMO organization. | `413 PAYLOAD_TOO_LARGE`, `429`, `403` |
| 2 | Name | Display name = basename only. Path parts, control characters and symbols are replaced, leading dots removed, 120 characters max. The name is never used to read or write files. | — |
| 3 | Type detection | Allow-list of extensions: `.csv`, `.txt` (CSV), `.xlsx`. The real type comes from the bytes: `PK\x03\x04` = zip, needed for `.xlsx` and refused for `.csv`. Refused by signature: OLE2 (`.xls` or encrypted Office), MZ/ELF executables, PDF, PNG/JPEG/GIF, gzip, RAR, 7z. CSV must contain no NUL bytes and must decode as UTF-8 (BOM stripped), otherwise as Windows-1252. The client MIME type is **recorded but not trusted**. | `422 VALIDATION_FAILED` (stage `file`), audited as `import.rejected` |
| 4 | .xlsx container | The zip central directory is read without decompressing anything. Refused: no `[Content_Types].xml` / `xl/workbook.xml`; encrypted entries (flag bit 0); ZIP64; more than 2,000 entries; uncompressed total over 64 MiB; any entry over 1 MiB with a compression ratio over 200; names that are absolute or contain `..`, `\` or control characters; duplicate names; `vbaProject.bin`, `xl/activeX/`, `xl/embeddings/`, `xl/externalLinks/`, `*.bin`. | 422 |
| 5 | Malware scan | `UPLOAD_SCAN_MODE=clamav` streams the bytes to clamd (`INSTREAM`, 64 KiB chunks, 15 s timeout). INFECTED → rejected and not stored. With `UPLOAD_SCAN_REQUIRED=true`, NOT_SCANNED or a scanner error → rejected (fail closed). The result is stored on the job as `scan_status`. | 422 / `503 UPSTREAM_UNAVAILABLE` |
| 6 | Parse | CSV: line count pre-check, then PapaParse without type conversion. Delimiter auto-detected; comma recommended. .xlsx: ExcelJS, first worksheet only. Formulas are **never evaluated**: the cached result is read as text. Rich text is flattened; dates become `YYYY-MM-DD`. Limits: `IMPORT_MAX_ROWS` data rows, 50 columns, 100-character unique headers (matched ignoring case, spaces and underscores). | 422 |
| 7 | Map | Header aliases, or an explicit `mapping` JSON. A missing required column → job FAILED with `COLUMN_NOT_FOUND` (row 1). | report |
| 8 | Validate fields | Per row: required fields, 500-character cell cap, member number / name / group patterns, phone normalisation (libphonenumber, default NG; NG must be a 10-digit mobile), known plan code, dates (ISO or day-first, 1990–2100, real calendar dates, HMO time zone), end ≥ start, status vocabulary. | row errors |
| 9 | Duplicates and conflicts | See §2. Uses set-based queries (`IN` lists of up to 1,000) against **the caller's HMO only**. | errors / warnings / CONFLICT |
| 10 | Stage | Each importable row → `import_rows` (row number, member number, classification, warnings, changed fields, status `PENDING`). The normalised record **and the original cell values** go into `payload_enc`, encrypted with AES-256-GCM. Job counters, errors and warnings go to `import_jobs`. One transaction. | — |
| 11 | Apply | `POST /apply` claims the file hash (`appliedFileSha`, unique per HMO), sets `QUEUED` and enqueues `IMPORT_APPLY`. At most `IMPORT_INLINE_MAX_ROWS` (500) rows → processed before the response returns. More → `202`, processed by the worker. | — |
| 12 | Process | Batches of `IMPORT_BATCH_SIZE` (500). Each batch is one transaction: lock `PENDING` rows `FOR UPDATE SKIP LOCKED` → apply → mark each row APPLIED or HELD in the **same** transaction → merge the summary → refresh the counters. A non-transient error in a batch → the batch rolls back and is reapplied row by row, so only the bad row is FAILED (with a code, no values). A transient error (serialization, deadlock, lock timeout, connection) → the whole job is retried with back-off. The lease is renewed after each batch. | — |
| 13 | Finish | Status APPLIED (all applied), PARTIALLY_APPLIED (some held, failed or not processed) or FAILED (nothing applied). Staging cleared except held rows. Audit `import.applied` / `import.partially_applied` / `import.failed` with counts. | — |

## 2. Duplicate and conflict rules

| Situation | Scope | Handling |
|---|---|---|
| Same member number (case-insensitive) + plan + start date twice in the file | File | Error `DUPLICATE_IN_FILE` on the later row |
| Same member number, different name or phone in the file | File | Error `CONFLICT_IN_FILE` / `PHONE_CONFLICT_IN_FILE` on the later row |
| Member numbers differing only by letter case | File and HMO | Same member. Warning. The stored spelling is kept |
| Member numbers differing only by punctuation | File and HMO | Warning `POSSIBLE_DUPLICATE_*`. **Never merged** |
| Leading or trailing whitespace | — | Trimmed before comparison. Inner spaces in a member number are an error |
| Phone formats (`0803…`, `+234…`, spaces, brackets) | — | Normalised to E.164 before comparison |
| Phone shared by several member numbers in the file | File | Warning (FLAG) or error (REJECT) |
| Phone already on another member | **This HMO only** | Warning (FLAG) or error (REJECT). Never compared across HMOs |
| Existing member, same name, other fields differ | HMO | UPDATE (phone and/or coverage). Reported before applying |
| Existing member, nothing differs | HMO | UNCHANGED |
| Existing member, first or last name differs (ignoring case, spacing and accents) | HMO | CONFLICT → **held**. Applied only with `acceptIdentityChanges` (needs `members:write`) or `apply-held`. Audited as `member.identity_changed` (field names only) |
| Overlapping coverage on the same plan with a different start | HMO | Warning `OVERLAPPING_COVERAGE` |
| Coverage end moved before already authorized visits | HMO | Applied. Visits and claims **not** reversed. Listed as `retroactiveConflicts` and audited |
| Byte-identical file already applied | HMO | Nothing applied. The earlier job is returned; this job is CANCELLED with `duplicateOf` |
| Same member number at another HMO | Platform | Different person. No interaction |

Uniqueness in the database: `members (hmo_org_id, upper(member_number))` is unique. Phone numbers are not unique (shared phones are legitimate). `import_rows (import_job_id, row_number)` is unique. `background_jobs (kind, ref_id)` is unique.

## 3. Idempotency and concurrency

| Event | Result |
|---|---|
| Double click on Apply, or a network retry | The second call sees QUEUED, PROCESSING or finished and returns the current state (`idempotentReplay: true`) |
| Two workers on one job | Rows are locked with `SKIP LOCKED` and re-checked as `status = 'PENDING'`, so each row is applied exactly once (tested with 3 concurrent processors) |
| Worker crash mid-job | The lease (60 s) expires; another worker claims the job and continues with the remaining `PENDING` rows (tested) |
| Transient database error | The batch rolls back and the job is re-queued with exponential back-off (2 s, 4 s, … up to 5 min, at most 5 attempts). After that, FAILED with `last_error`; `POST /apply` resumes it (tested) |
| A bad row | Only that row is FAILED; the rest of the batch is applied (tested) |

## 4. Where jobs run

- `npm run worker`: a dedicated process. Poll interval `WORKER_POLL_MS` (default 2 s). Graceful stop on SIGTERM. Run one or more copies.
- `JOBS_RUN_IN_WEB=true` (default): the web process also processes queued jobs right after a request that queued work, with one runner per process. Running both is safe.
- No new infrastructure: the queue is the `background_jobs` table in the existing PostgreSQL database. A dedicated broker (Redis, SQS) would be justified only at volumes far above pilot scale.

## 5. Security controls and what needs infrastructure

| Control | Status |
|---|---|
| Allow-list of types, content-based detection, signature checks | Implemented |
| Zip-bomb, macro, encryption, path-traversal and external-link checks for .xlsx | Implemented |
| Size cap before parsing (streamed) | Implemented |
| Row, column, header and cell limits | Implemented |
| Formula injection: formulas never evaluated on import; exported CSV cells starting with `= + - @ \t \r` are prefixed with `'` | Implemented |
| No files written to disk (no path traversal, nothing executable stored); staging encrypted; held payloads purged after 30 days (housekeeping) | Implemented |
| No personal data in errors, reports, audit metadata or logs (ids, codes, counts, member numbers only) | Implemented (tests assert no phone numbers or names) |
| Malware scanning | Implemented as a clamd client; **requires a ClamAV daemon** (sidecar container) in deployment; tested against a local protocol stand-in only |
| Processing-time limit | Bounded by the size, row and column limits and by batching; no hard CPU timeout inside a parse |
| WAF and global rate limiting, antivirus signature updates, TLS | Deployment infrastructure (not part of this repository) |

## 6. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `IMPORT_MAX_BYTES` | 5242880 | Maximum file size |
| `IMPORT_MAX_ROWS` | 20000 | Maximum data rows |
| `IMPORT_BATCH_SIZE` | 500 | Rows per transaction in the worker |
| `IMPORT_INLINE_MAX_ROWS` | 500 | Larger imports are queued |
| `JOBS_RUN_IN_WEB` | true | Process queued jobs inside the web process too |
| `UPLOAD_SCAN_MODE` | off | `off` or `clamav` |
| `CLAMAV_HOST` / `CLAMAV_PORT` | 127.0.0.1 / 3310 | clamd address |
| `UPLOAD_SCAN_REQUIRED` | false | `true` = fail closed when not scanned (recommended in production) |
