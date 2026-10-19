"use client";
/**
 * No-code benefit rule editor. Produces a BenefitRules document; the server validates it with the
 * same schema the engine uses. Fields appear only when they apply to the chosen limit/period type.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type Period =
  | { type: "DAY" }
  | { type: "WEEK"; weekStartsOn: string }
  | { type: "MONTH" }
  | { type: "YEAR"; anchor: "CALENDAR" | "COVERAGE_START" }
  | { type: "ROLLING_DAYS"; days: number }
  | { type: "CUSTOM"; start: string; end: string }
  | { type: "COVERAGE_TERM" }
  | { type: "LIFETIME" };
type Limit = { metric: "VISITS" | "QUANTITY" | "AMOUNT"; maximum: number; period: Period };
type Rules = {
  limits: Limit[];
  unlimited: boolean;
  currency: string;
  copay: { type: "NONE" } | { type: "FIXED"; amountMinor: number } | { type: "PERCENT"; basisPoints: number };
  waitingPeriodDays: number;
  requiresReferral: boolean;
  requiresPreauthorization: boolean;
  memberConfirmation: "OTP" | "NONE";
  eligibleProviderTypes: string[];
  excludedMemberGroups: string[];
  maxQuantityPerVisit: number;
  claimEvidence: { requireAttendanceConfirmation: boolean; requireNotes: boolean };
  authorizationValidityMinutes: number;
  checkInCooldownMinutes?: number;
  timezone: string;
};

const DEFAULT: Rules = {
  limits: [{ metric: "VISITS", maximum: 2, period: { type: "WEEK", weekStartsOn: "MONDAY" } }],
  unlimited: false,
  currency: "NGN",
  copay: { type: "NONE" },
  waitingPeriodDays: 0,
  requiresReferral: false,
  requiresPreauthorization: false,
  memberConfirmation: "OTP",
  eligibleProviderTypes: [],
  excludedMemberGroups: [],
  maxQuantityPerVisit: 1,
  claimEvidence: { requireAttendanceConfirmation: true, requireNotes: false },
  authorizationValidityMinutes: 240,
  timezone: "Africa/Lagos",
};

const PERIODS: { v: Period["type"]; label: string }[] = [
  { v: "DAY", label: "per day" },
  { v: "WEEK", label: "per week" },
  { v: "MONTH", label: "per calendar month" },
  { v: "YEAR", label: "per year" },
  { v: "ROLLING_DAYS", label: "per rolling number of days" },
  { v: "CUSTOM", label: "between two dates (treatment course)" },
  { v: "COVERAGE_TERM", label: "per coverage term" },
  { v: "LIFETIME", label: "lifetime" },
];
const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

function defaultPeriod(t: Period["type"]): Period {
  switch (t) {
    case "WEEK": return { type: "WEEK", weekStartsOn: "MONDAY" };
    case "YEAR": return { type: "YEAR", anchor: "CALENDAR" };
    case "ROLLING_DAYS": return { type: "ROLLING_DAYS", days: 30 };
    case "CUSTOM": { const d = new Date().toISOString().slice(0, 10); return { type: "CUSTOM", start: d, end: d }; }
    default: return { type: t } as Period;
  }
}
/** Number input that keeps the typed text, so people can clear and retype values. */
function NumField({ id, value, onValue, step = 1, min = 0, max }: { id: string; value: number; onValue: (n: number) => void; step?: number; min?: number; max?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input id={id} type="number" inputMode="decimal" step={step} min={min} max={max} value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value !== "" && Number.isFinite(Number(e.target.value))) onValue(Number(e.target.value));
      }} />
  );
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function RuleBuilder({ benefitId, initial }: { benefitId: string; initial?: Partial<Rules> }) {
  const router = useRouter();
  const [r, setR] = useState<Rules>({ ...DEFAULT, ...(initial ?? {}) } as Rules);
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date(Date.now() + 60_000).toISOString().slice(0, 16));
  const [summary, setSummary] = useState<string>("");
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => setR((p) => ({ ...p, [k]: v }));
  const setLimit = (i: number, patch: Partial<Limit>) => setR((p) => ({ ...p, limits: p.limits.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const body = useMemo(() => ({ ...r, limits: r.unlimited ? [] : r.limits }), [r]);

  useEffect(() => {
    const t = setTimeout(async () => {
      const res = await fetch("/v1/benefits/validate-rules", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) return;
      const j = await res.json();
      setSummary(j.valid ? j.summary : "");
      setIssues(j.valid ? [] : j.issues);
    }, 300);
    return () => clearTimeout(t);
  }, [body]);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/v1/benefits/${benefitId}/versions`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effectiveFrom: new Date(effectiveFrom).toISOString(), rules: body }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: j.error?.details?.map?.((d: { path: string; message: string }) => `${d.path}: ${d.message}`).join("; ") || j.error?.message || "Could not save" });
    setMsg({ ok: true, text: `Draft version ${j.version} saved. Publish it below to put it into effect.` });
    router.refresh();
  }

  const showQty = !r.unlimited && r.limits.some((l) => l.metric === "QUANTITY");

  return (
    <div className="panel">
      <h3>Usage limit</h3>
      <label className="check"><input type="checkbox" checked={r.unlimited} onChange={(e) => set("unlimited", e.target.checked)} /> No usage limit (the plan allows unlimited use)</label>
      {!r.unlimited && (
        <>
          {r.limits.map((l, i) => (
            <div className="row" key={i} style={{ marginTop: 8 }}>
              <div className="field" style={{ flex: "0 0 140px" }}>
                <label htmlFor={`max${i}`}>{l.metric === "AMOUNT" ? "Up to (₦)" : "Up to"}</label>
                <NumField id={`max${i}`} step={l.metric === "AMOUNT" ? 0.01 : 1} value={l.metric === "AMOUNT" ? l.maximum / 100 : l.maximum}
                  onValue={(n) => setLimit(i, { maximum: l.metric === "AMOUNT" ? Math.round(n * 100) : Math.round(n) })} />
              </div>
              <div className="field">
                <label htmlFor={`met${i}`}>Counting</label>
                <select id={`met${i}`} value={l.metric} onChange={(e) => setLimit(i, { metric: e.target.value as Limit["metric"] })}>
                  <option value="VISITS">visits</option><option value="QUANTITY">sessions / units</option><option value="AMOUNT">naira paid by the HMO</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor={`per${i}`}>Period</label>
                <select id={`per${i}`} value={l.period.type} onChange={(e) => setLimit(i, { period: defaultPeriod(e.target.value as Period["type"]) })}>
                  {PERIODS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
                </select>
              </div>
              {l.period.type === "WEEK" && (
                <div className="field"><label htmlFor={`wk${i}`}>Week starts</label>
                  <select id={`wk${i}`} value={l.period.weekStartsOn} onChange={(e) => setLimit(i, { period: { type: "WEEK", weekStartsOn: e.target.value } })}>
                    {DAYS.map((d) => <option key={d} value={d}>{d[0] + d.slice(1).toLowerCase()}</option>)}
                  </select></div>
              )}
              {l.period.type === "YEAR" && (
                <div className="field"><label htmlFor={`yr${i}`}>Year runs</label>
                  <select id={`yr${i}`} value={l.period.anchor} onChange={(e) => setLimit(i, { period: { type: "YEAR", anchor: e.target.value as "CALENDAR" } })}>
                    <option value="CALENDAR">January to December</option><option value="COVERAGE_START">from each member&apos;s coverage start</option>
                  </select></div>
              )}
              {l.period.type === "ROLLING_DAYS" && (
                <div className="field" style={{ flex: "0 0 120px" }}><label htmlFor={`rd${i}`}>Days</label>
                  <NumField id={`rd${i}`} min={1} value={l.period.days} onValue={(n) => setLimit(i, { period: { type: "ROLLING_DAYS", days: Math.round(n) } })} /></div>
              )}
              {l.period.type === "CUSTOM" && (
                <>
                  <div className="field"><label htmlFor={`cs${i}`}>From</label><input id={`cs${i}`} type="date" value={l.period.start} onChange={(e) => setLimit(i, { period: { ...(l.period as { type: "CUSTOM"; start: string; end: string }), start: e.target.value } })} /></div>
                  <div className="field"><label htmlFor={`ce${i}`}>To (inclusive)</label><input id={`ce${i}`} type="date" value={l.period.end} onChange={(e) => setLimit(i, { period: { ...(l.period as { type: "CUSTOM"; start: string; end: string }), end: e.target.value } })} /></div>
                </>
              )}
              {r.limits.length > 1 && <div className="field" style={{ flex: "0 0 auto" }}><button type="button" className="small danger" onClick={() => set("limits", r.limits.filter((_, j) => j !== i))}>Remove</button></div>}
            </div>
          ))}
          {r.limits.length < 5 && (
            <button type="button" className="small secondary" onClick={() => set("limits", [...r.limits, { metric: "AMOUNT", maximum: 5_000_000, period: { type: "YEAR", anchor: "CALENDAR" } }])}>
              Add another limit (all limits must be met)
            </button>
          )}
        </>
      )}

      <h3>Member pays</h3>
      <div className="row">
        <div className="field">
          <label htmlFor="cp">Co-payment</label>
          <select id="cp" value={r.copay.type} onChange={(e) => set("copay", e.target.value === "FIXED" ? { type: "FIXED", amountMinor: 0 } : e.target.value === "PERCENT" ? { type: "PERCENT", basisPoints: 1000 } : { type: "NONE" })}>
            <option value="NONE">Nothing</option><option value="FIXED">A fixed amount per visit</option><option value="PERCENT">A percentage of the tariff</option>
          </select>
        </div>
        {r.copay.type === "FIXED" && <div className="field"><label htmlFor="cpa">Amount (₦)</label><NumField id="cpa" step={0.01} value={r.copay.amountMinor / 100} onValue={(n) => set("copay", { type: "FIXED", amountMinor: Math.round(n * 100) })} /></div>}
        {r.copay.type === "PERCENT" && <div className="field"><label htmlFor="cpp">Percent</label><NumField id="cpp" max={100} step={0.01} value={r.copay.basisPoints / 100} onValue={(n) => set("copay", { type: "PERCENT", basisPoints: Math.round(n * 100) })} /></div>}
      </div>

      <h3>Conditions</h3>
      <div className="row">
        <div className="field"><label htmlFor="conf">Member confirms each visit</label>
          <select id="conf" value={r.memberConfirmation} onChange={(e) => set("memberConfirmation", e.target.value as "OTP")}><option value="OTP">By a code sent to their phone</option><option value="NONE">No confirmation</option></select></div>
        <div className="field"><label htmlFor="wait">Waiting period (days after coverage starts)</label><NumField id="wait" value={r.waitingPeriodDays} onValue={(n) => set("waitingPeriodDays", Math.round(n))} /></div>
        <div className="field">
          <label htmlFor="cool">Minutes between check-ins <span className="hint">(blank = platform default, 0 = none)</span></label>
          <input id="cool" type="number" min={0} max={10080} step={1} inputMode="numeric" placeholder="default"
            value={r.checkInCooldownMinutes ?? ""}
            onChange={(e) => set("checkInCooldownMinutes", e.target.value === "" ? undefined : Math.max(0, Math.round(Number(e.target.value))))} />
        </div>
        {showQty && <div className="field"><label htmlFor="mq">Most sessions in one visit</label><NumField id="mq" min={1} value={r.maxQuantityPerVisit} onValue={(n) => set("maxQuantityPerVisit", Math.round(n))} /></div>}
      </div>
      <label className="check"><input type="checkbox" checked={r.requiresReferral} onChange={(e) => set("requiresReferral", e.target.checked)} /> Requires a referral</label>
      <label className="check"><input type="checkbox" checked={r.requiresPreauthorization} onChange={(e) => set("requiresPreauthorization", e.target.checked)} /> Requires a pre-authorization for each visit</label>
      <label className="check"><input type="checkbox" checked={r.claimEvidence.requireNotes} onChange={(e) => set("claimEvidence", { ...r.claimEvidence, requireNotes: e.target.checked })} /> Provider must add service notes to claims</label>
      <div className="row" style={{ marginTop: 8 }}>
        <div className="field"><label htmlFor="pt">Only these provider types <span className="hint">(comma-separated, blank = any)</span></label><input id="pt" type="text" defaultValue={r.eligibleProviderTypes.join(", ")} onBlur={(e) => set("eligibleProviderTypes", list(e.target.value).map((x) => x.toUpperCase()))} /></div>
        <div className="field"><label htmlFor="xg">Exclude member groups <span className="hint">(comma-separated)</span></label><input id="xg" type="text" defaultValue={r.excludedMemberGroups.join(", ")} onBlur={(e) => set("excludedMemberGroups", list(e.target.value))} /></div>
        <div className="field"><label htmlFor="av">Hours to complete an authorized visit</label><NumField id="av" min={1} max={168} step={0.5} value={r.authorizationValidityMinutes / 60} onValue={(n) => set("authorizationValidityMinutes", Math.round(n * 60))} /></div>
      </div>

      <h3>Takes effect</h3>
      <div className="row">
        <div className="field"><label htmlFor="ef">From</label><input id="ef" type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></div>
      </div>
      <p aria-live="polite">{summary ? <>Members get: <b>{summary}</b></> : issues.length ? <span className="tag no">{issues.map((i) => i.message).join("; ")}</span> : null}</p>
      <button type="button" onClick={save} disabled={busy || issues.length > 0}>Save as draft</button>
      {msg && <div className={`flash ${msg.ok ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
