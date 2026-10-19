import Link from "next/link";
import { smsStatus } from "@/lib/server/sms";

/** Visible on every portal while SMS is simulated, so test texts are never mistaken for real ones. */
export function SmsBanner() {
  const s = smsStatus();
  if (s.mode === "live") return null;
  return (
    <div className="smsbanner noprint" role="note">
      {s.mode === "simulate" ? (
        <>
          Text messages are simulated — nothing is sent to real phones.{s.fixedOtp ? ` Every code is ${s.fixedOtp}.` : ""}{" "}
          <Link href="/simulator" target="_blank">Open the phone simulator</Link>
        </>
      ) : (
        <>Text messages are turned off. Member confirmation codes cannot be delivered.</>
      )}
    </div>
  );
}
