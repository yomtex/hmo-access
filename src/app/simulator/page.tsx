import { notFound } from "next/navigation";
import { assertSimulatorAccess } from "@/lib/server/services/simulator";
import { assertBankSimulatorAccess } from "@/lib/server/services/payments";
import { smsStatus } from "@/lib/server/sms";
import { currentActor } from "@/lib/server/web";
import { BankSimulator } from "./BankSimulator";
import { PhoneSimulator } from "./PhoneSimulator";

export const dynamic = "force-dynamic";
export const metadata = { title: "Simulators" };

const allowed = (fn: () => void) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

export default async function SimulatorPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const actor = await currentActor();
  const phone = allowed(() => assertSimulatorAccess(actor));
  const bank = allowed(() => assertBankSimulatorAccess(actor));
  if (!phone && !bank) notFound();
  const tab = (await searchParams).tab === "bank" && bank ? "bank" : phone ? "phone" : "bank";
  const s = smsStatus();
  const provider = s.liveProvider === "termii" ? "Termii" : s.liveProvider;
  return (
    <div className="simwrap">
      <nav className="simtabs" aria-label="Simulators">
        {phone && <a href="/simulator" aria-current={tab === "phone" ? "page" : undefined}>Phone (texts)</a>}
        {bank && <a href="/simulator?tab=bank" aria-current={tab === "bank" ? "page" : undefined}>Bank (payments)</a>}
      </nav>
      {tab === "phone" ? (
        <>
          <header className="simhead">
            <div>
              <h1>Phone simulator</h1>
              <p className="muted">
                Every text the platform would send appears here instead of on a real phone. Each message goes through the {provider} adapter,
                which builds the real request and stops before sending it (open &ldquo;Request&rdquo; under a message to see it).
                {s.liveConfigured ? ` ${provider} keys are set; simulation is still on, so nothing leaves this computer.` : ` No ${provider} keys are set yet; the preview shows where they would go.`}
                {s.fixedOtp ? ` Every code is fixed to ${s.fixedOtp} (DEV_FIXED_OTP).` : ""}
              </p>
            </div>
          </header>
          <PhoneSimulator />
        </>
      ) : (
        <>
          <header className="simhead">
            <div>
              <h1>Bank simulator</h1>
              <p className="muted">
                Stands in for the payment partner and the banks. The real Paystack adapter runs against it: account name checks, collection accounts,
                signed notifications and transaction re-queries all use the same code as live, only the network is replaced. No money moves.
              </p>
            </div>
          </header>
          <BankSimulator />
        </>
      )}
    </div>
  );
}
