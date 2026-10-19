"use client";
/**
 * Gym reception screen.
 *
 * Built for a tablet or PC at the front desk with a USB/Bluetooth QR scanner. Those scanners act as a
 * keyboard: they "type" the code very fast and press Enter. The screen listens for that pattern
 * anywhere on the page, so the member just holds their QR (card or phone) to the scanner and the
 * check starts by itself — no clicking. A phone/tablet camera works too.
 *
 * Flow: scan → eligibility → (auto) text a code to the member → staff types the code the member reads
 * out → visit authorized → (optional) marked done → screen resets for the next member.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { afterVisit, api, ApiError, clock, naira, periodLabel, type Auth, type Check, type Intent, type Limit, type Result } from "./api";

type Phase = "idle" | "checking" | "choose" | "result" | "code" | "working" | "done";
type Settings = { autoSendCode: boolean; completeOnCheckIn: boolean; resetSeconds: number; sound: boolean };
const DEFAULTS: Settings = { autoSendCode: true, completeOnCheckIn: true, resetSeconds: 8, sound: true };
const SETTINGS_KEY = "hmoa.reception.settings";

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

function beep(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.15 : 0.35));
  } catch {
    /* audio unavailable */
  }
}

/** Detects keyboard-wedge scanners: ≥8 characters typed <50 ms apart, ending with Enter. */
function useScanner(onScan: (code: string) => void, enabled: boolean) {
  const buf = useRef("");
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Typing into a normal field (e.g. the code box) belongs to that field.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && !t.dataset.scanTarget) return;
      const now = performance.now();
      if (now - last.current > 50) buf.current = "";
      last.current = now;
      if (e.key === "Enter") {
        const code = buf.current;
        buf.current = "";
        if (code.length >= 8) {
          e.preventDefault();
          cb.current(code);
        }
        return;
      }
      if (e.key.length === 1) buf.current += e.key;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}

function Pips({ l, currency }: { l: Limit; currency: string }) {
  if (l.metric === "AMOUNT") {
    return <p className="k-allow"><b>{naira(l.remaining, currency)}</b> of {naira(l.maximum, currency)} left {periodLabel(l)}</p>;
  }
  const unit = l.metric === "VISITS" ? "visit" : "session";
  return (
    <div className="k-allow">
      {l.maximum <= 14 && (
        <div className="pips" aria-hidden="true">
          {Array.from({ length: l.maximum }, (_, i) => <span key={i} className={`pip ${i >= l.remaining ? "used" : ""}`} />)}
        </div>
      )}
      <p><b>{l.remaining} of {l.maximum}</b> {unit}{l.maximum === 1 ? "" : "s"} left {periodLabel(l)}</p>
    </div>
  );
}

export function ReceptionKiosk({ branchName, simulateSms }: { branchName: string; simulateSms: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [showSettings, setShowSettings] = useState(false);
  const [manual, setManual] = useState("");
  const [camera, setCamera] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [limits, setLimits] = useState<Limit[]>([]);
  const [completed, setCompleted] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const idem = useRef("");
  const manualRef = useRef<HTMLInputElement>(null);

  useEffect(() => setSettings(loadSettings()), []);
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable */
    }
  }, [settings]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setCheck(null);
    setResult(null);
    setIntent(null);
    setAuth(null);
    setLimits([]);
    setCompleted(false);
    setCode("");
    setError(null);
    setNotice(null);
    setManual("");
    setCountdown(null);
    setTimeout(() => manualRef.current?.focus(), 50);
  }, []);

  // Auto-reset after a finished or refused visit.
  useEffect(() => {
    const finished = phase === "done" || (phase === "result" && result && result.decision !== "ELIGIBLE");
    if (!finished) return setCountdown(null);
    const seconds = phase === "done" ? settings.resetSeconds : settings.resetSeconds * 2;
    setCountdown(seconds);
    const started = Date.now();
    const t = setInterval(() => {
      const left = seconds - Math.floor((Date.now() - started) / 1000);
      if (left <= 0) {
        clearInterval(t);
        reset();
      } else setCountdown(left);
    }, 250);
    return () => clearInterval(t);
  }, [phase, result, settings.resetSeconds, reset]);

  async function authorizeAndMaybeComplete(i: Intent, r: Result) {
    const a = await api<{ authorization: Auth }>(`/v1/visit-intents/${i.id}/authorize`, { method: "POST", idem: idem.current });
    setAuth(a.authorization);
    setLimits(afterVisit(r.limits, a.authorization));
    if (settings.completeOnCheckIn) {
      await api(`/v1/authorizations/${a.authorization.id}/complete`, { method: "POST", body: JSON.stringify({ attendanceConfirmed: true, submitClaim: true }) });
      setCompleted(true);
    }
    if (settings.sound) beep(true);
    setPhase("done");
  }

  async function startVisit(r: Result) {
    setPhase("working");
    setError(null);
    try {
      // The server returns the check-in already in progress (scanOutcome DUPLICATE) instead of starting a
      // second one, so a double scan never sends a second code or records a second visit.
      const i = await api<Intent>("/v1/visit-intents", { method: "POST", body: JSON.stringify({ eligibilityCheckId: r.eligibilityCheckId }) });
      idem.current = crypto.randomUUID();
      setIntent(i);
      if (i.scanOutcome === "DUPLICATE") setNotice("Same member scanned again: continuing the check-in already in progress. No new code was sent.");
      if (i.confirmationMethod === "NONE") await authorizeAndMaybeComplete(i, r);
      else setPhase("code");
    } catch (e) {
      setError((e as Error).message);
      setPhase("result");
    }
  }

  function show(r: Result) {
    setResult(r);
    setLimits(r.limits);
    setPhase("result");
    if (settings.sound) beep(r.decision === "ELIGIBLE");
    if (r.decision === "ELIGIBLE" && (r.confirmation === "NONE" || settings.autoSendCode)) void startVisit(r);
  }

  async function lookup(raw: string) {
    const v = raw.trim();
    if (!v) return;
    reset();
    setPhase("checking");
    const body = v.startsWith("HMOA1.") ? { method: "QR", qr: v } : { method: "MEMBER_REF", memberRef: v.toUpperCase() };
    try {
      const c = await api<Check>("/v1/eligibility/checks", { method: "POST", body: JSON.stringify({ lookup: body }) });
      setCheck(c);
      if (c.results.length === 1) show(c.results[0]);
      else setPhase("choose");
    } catch (e) {
      if (settings.sound) beep(false);
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  useScanner((c) => void lookup(c), phase !== "working" && phase !== "checking");

  async function verify() {
    if (!intent || !result || code.length !== 6) return;
    setPhase("working");
    setError(null);
    try {
      await api(`/v1/visit-intents/${intent.id}/otp/verify`, { method: "POST", body: JSON.stringify({ code }) });
      await authorizeAndMaybeComplete(intent, result);
    } catch (e) {
      const err = e as ApiError;
      setError(err.attemptsRemaining !== undefined ? `Wrong code. ${err.attemptsRemaining} tries left.` : err.message);
      setCode("");
      setPhase(intent && err.code !== "NOT_ELIGIBLE" ? "code" : "result");
    }
  }

  async function resend() {
    if (!intent) return;
    try {
      setIntent(await api<Intent>(`/v1/visit-intents/${intent.id}/otp/resend`, { method: "POST" }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function completeNow() {
    if (!auth) return;
    try {
      await api(`/v1/authorizations/${auth.id}/complete`, { method: "POST", body: JSON.stringify({ attendanceConfirmed: true, submitClaim: true }) });
      setCompleted(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const key = (d: string) => setCode((c) => (d === "⌫" ? c.slice(0, -1) : (c + d).slice(0, 6)));
  const resendIn = intent?.otp?.resendAvailableAt ? Math.max(0, Math.ceil((new Date(intent.otp.resendAvailableAt).getTime() - now) / 1000)) : null;
  const currency = result?.pricing?.currency ?? "NGN";
  const cooldown = result?.checkIn?.outcome === "COOLDOWN" ? result.checkIn : null;
  const tone = phase === "done" ? "ok" : cooldown ? "warn" : result?.decision === "INELIGIBLE" ? "no" : result?.decision === "UNVERIFIABLE" ? "warn" : result ? "ok" : "idle";

  return (
    <div className={`kiosk tone-${tone}`}>
      {phase === "idle" || phase === "checking" ? (
        <section className="k-idle">
          <div className={`k-scanmark ${phase === "checking" ? "busy" : ""}`} aria-hidden="true">
            <span /><span /><span /><span />
          </div>
          <h1>{phase === "checking" ? "Checking…" : "Ready for the next member"}</h1>
          <p className="k-lead">Ask the member to hold their QR code up to the scanner. It reads automatically.</p>
          {error && <div className="k-alert" role="alert">{error}</div>}
          <form
            className="k-manual"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup(manual);
            }}
          >
            <label htmlFor="k-manual">No QR? Type the member reference</label>
            <div className="row">
              <input id="k-manual" ref={manualRef} data-scan-target="1" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="HM-7K2M9QP" autoComplete="off" spellCheck={false} autoFocus />
              <button type="submit" disabled={!manual.trim() || phase === "checking"}>Check</button>
              <button type="button" className="secondary" onClick={() => setCamera((c) => !c)}>{camera ? "Stop camera" : "Use camera"}</button>
            </div>
          </form>
          {camera && <CameraScanner onCode={(c) => { setCamera(false); void lookup(c); }} onError={(m) => { setCamera(false); setError(m); }} />}
        </section>
      ) : (
        <section className="k-result" aria-live="polite">
          {check && (
            <p className="k-who">
              <b>{check.member.displayName}</b> · {check.hmoName}{result ? ` · ${result.benefitName}` : ""}
            </p>
          )}

          {phase === "choose" && check && (
            <>
              <h1>Which service today?</h1>
              <div className="k-choices">
                {check.results.map((r) => <button key={r.eligibilityCheckId} className="k-big" onClick={() => show(r)}>{r.benefitName}</button>)}
              </div>
            </>
          )}

          {result && phase !== "choose" && (
            <>
              <h1 className="k-verdict">
                {phase === "done"
                  ? `Welcome in, ${check?.member.displayName.split(" ")[0]}`
                  : cooldown
                    ? "Already checked in"
                    : result.decision === "ELIGIBLE"
                    ? "Eligible"
                    : result.decision === "INELIGIBLE"
                      ? "Not eligible"
                      : "Can’t verify right now"}
              </h1>
              {cooldown && (
                <div className="k-cooldown">
                  <p>
                    {cooldown.existing
                      ? <>Checked in {cooldown.existing.sameBranch ? "here" : "at your other branch"} at <b>{clock(cooldown.existing.authorizedAt)}</b> (visit {cooldown.existing.authorizationReference}). If they are coming back in, let them through — <b>no new visit is recorded</b>.</>
                      : <>This member checked in for this benefit at <b>{cooldown.lastCheckInAt ? clock(cooldown.lastCheckInAt) : "a moment ago"}</b>. No new visit is recorded.</>}
                  </p>
                  {cooldown.nextAllowedAt && <p className="small">A new check-in is possible from {clock(cooldown.nextAllowedAt)} ({cooldown.cooldownMinutes} minutes between check-ins).</p>}
                </div>
              )}
              {result.decision !== "ELIGIBLE" && !cooldown && (
                <>
                  <ul className="k-reasons">{result.reasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul>
                  <p>Don&apos;t admit on this benefit. {result.decision === "UNVERIFIABLE" ? "Ask the member to contact their HMO, or try again shortly." : "The member can contact their HMO."}</p>
                </>
              )}
              {result.decision === "ELIGIBLE" && (
                <>
                  {result.unlimited && <p className="k-allow">No visit limit on this benefit</p>}
                  {limits.map((l, i) => <Pips key={i} l={l} currency={currency} />)}
                  {result.pricing && result.pricing.copayMinor > 0 && (
                    <p className="k-copay">Collect <b>{naira(result.pricing.copayMinor, currency)}</b> co-payment</p>
                  )}
                </>
              )}

              {phase === "result" && result.decision === "ELIGIBLE" && !intent && (
                <button className="k-big" onClick={() => void startVisit(result)}>
                  {result.confirmation === "OTP" ? `Text a code to ${check?.member.phoneMasked ?? "the member"}` : "Check the member in"}
                </button>
              )}

              {(phase === "code" || (phase === "working" && intent && !auth)) && intent?.otp && (
                <div className="k-code">
                  {intent.otp.status === "SEND_FAILED" ? (
                    <div className="k-alert">The text could not be sent. Try again; if it keeps failing the member can&apos;t be confirmed now.</div>
                  ) : (
                    <p>Ask the member for the code sent to <b>{intent.otp.phoneMasked}</b>.</p>
                  )}
                  <form onSubmit={(e) => { e.preventDefault(); void verify(); }}>
                    <input
                      className="k-digits"
                      aria-label="Code from member"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      autoFocus
                    />
                    <div className="k-keypad" role="group" aria-label="Number pad">
                      {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0"].map((d) => (
                        <button type="button" key={d} className="secondary" onClick={() => key(d)} aria-label={d === "⌫" ? "Delete" : d}>{d}</button>
                      ))}
                      <button type="submit" disabled={code.length !== 6 || phase === "working"}>OK</button>
                    </div>
                  </form>
                  <div className="row k-sub">
                    <button className="secondary small" onClick={resend} disabled={resendIn === null || resendIn > 0 || intent.otp.sendsRemaining === 0}>
                      {intent.otp.sendsRemaining === 0 ? "No more codes" : resendIn && resendIn > 0 ? `New code in ${resendIn}s` : "Send a new code"}
                    </button>
                    {simulateSms && <a className="small" href="/simulator" target="_blank" rel="noreferrer">Open phone simulator</a>}
                  </div>
                </div>
              )}

              {phase === "working" && !intent && <p className="k-lead">Starting the visit…</p>}

              {phase === "done" && auth && (
                <div className="k-donebox">
                  <p>Visit <b>{auth.reference}</b> {completed ? "recorded and claim sent to the HMO." : "authorized."}</p>
                  {!completed && <button onClick={completeNow}>Mark visit done</button>}
                  <p className="small">The member gets a text receipt. <a href={`/receipt/${auth.reference}`} target="_blank" rel="noreferrer">Print receipt</a></p>
                </div>
              )}
              {notice && <div className="k-note" role="status">{notice}</div>}
              {error && <div className="k-alert" role="alert">{error}</div>}
            </>
          )}

          <div className="k-foot">
            <button className="secondary" onClick={reset}>
              {countdown !== null ? `Next member (${countdown})` : "Next member"}
            </button>
            <span className="small muted">Scanning a new code also starts over.</span>
          </div>
        </section>
      )}

      <div className="k-settings">
        {showSettings && (
          <div className="k-settings-panel">
            <label className="check"><input type="checkbox" checked={settings.autoSendCode} onChange={(e) => setSettings({ ...settings, autoSendCode: e.target.checked })} /> Text the member a code as soon as they are eligible</label>
            <label className="check"><input type="checkbox" checked={settings.completeOnCheckIn} onChange={(e) => setSettings({ ...settings, completeOnCheckIn: e.target.checked })} /> Mark the visit done at check-in (entry is the service)</label>
            <label className="check"><input type="checkbox" checked={settings.sound} onChange={(e) => setSettings({ ...settings, sound: e.target.checked })} /> Beep on result</label>
            <label className="check">
              Return to scanning after
              <select value={settings.resetSeconds} onChange={(e) => setSettings({ ...settings, resetSeconds: Number(e.target.value) })} style={{ width: "auto" }}>
                {[5, 8, 12, 20].map((s) => <option key={s} value={s}>{s} s</option>)}
              </select>
            </label>
            <p className="small muted">Settings are saved on this device only. {branchName}.</p>
          </div>
        )}
        <button className="secondary small" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>Screen settings</button>
      </div>
    </div>
  );
}

function CameraScanner({ onCode, onError }: { onCode: (c: string) => void; onError: (m: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onCode, onError });
  cb.current = { onCode, onError };
  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement("canvas");
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current || stopped) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = () => {
          const v = video.current;
          if (!v || stopped) return;
          if (v.readyState === v.HAVE_ENOUGH_DATA) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(v, 0, 0);
              const hit = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
              if (hit?.data?.startsWith("HMOA1.")) return cb.current.onCode(hit.data);
            }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        cb.current.onError("The camera could not be opened. Use the scanner or type the reference.");
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return <video ref={video} className="scanner" muted playsInline aria-label="Camera preview for scanning a member QR code" />;
}
