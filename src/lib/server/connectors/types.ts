/**
 * Connector architecture.
 *
 * Every HMO data source — CSV/Excel upload, REST API, webhook push, FHIR, scheduled file drop —
 * is normalised into the same NormalizedMemberRecord before it touches the database. Only the
 * mapping layer differs per HMO; the eligibility engine never knows where data came from.
 */
export type NormalizedMemberRecord = {
  memberNumber: string;
  firstName: string;
  lastName: string;
  /** E.164, already normalised. */
  phone: string | null;
  planCode: string;
  /** UTC instant of local midnight on the first covered day. */
  coverageStart: Date;
  /** Exclusive UTC instant (local midnight after the last covered day), or null if open-ended. */
  coverageEnd: Date | null;
  coverageStatus: "ACTIVE" | "SUSPENDED" | "TERMINATED";
  memberGroup: string | null;
};

export type RowError = { row: number; field: string; code: string; message: string };

export type ConnectorKind = "CSV_UPLOAD" | "REST_API" | "WEBHOOK" | "FHIR" | "SCHEDULED_FILE";

/** Realtime status lookup used at eligibility time (optional per connector). */
export type LiveLookupResult =
  | { ok: true; record: Partial<NormalizedMemberRecord> & { memberStatus?: "ACTIVE" | "SUSPENDED" | "TERMINATED" } | null }
  | { ok: false; reason: "TIMEOUT" | "UNAVAILABLE" | "BAD_RESPONSE" | "NOT_CONFIGURED" };

export interface LiveMemberConnector {
  readonly kind: ConnectorKind;
  lookupMember(memberNumber: string): Promise<LiveLookupResult>;
}

/**
 * Adapter status — documented so nobody mistakes a reference adapter for a certified integration.
 *  CSV_UPLOAD      implemented, tested
 *  WEBHOOK         implemented (generic signed JSON push), tested; no HMO has integrated yet
 *  REST_API        reference adapter (generic JSON GET + field map), tested against a local stub only
 *  FHIR            not implemented — interface reserved
 *  SCHEDULED_FILE  not implemented — interface reserved (reuse CSV parser)
 */
export const CONNECTOR_STATUS: Record<ConnectorKind, string> = {
  CSV_UPLOAD: "implemented",
  WEBHOOK: "implemented (generic signed JSON)",
  REST_API: "reference adapter (not certified with any HMO)",
  FHIR: "not implemented",
  SCHEDULED_FILE: "not implemented",
};
