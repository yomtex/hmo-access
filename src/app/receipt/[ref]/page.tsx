import { notFound } from "next/navigation";
import { getReceipt } from "@/lib/server/services/visits";
import { errorMessage, requireActor } from "@/lib/server/web";
import { dt } from "@/lib/format";
import { PrintButton } from "@/components/PrintButton";

export const metadata = { title: "Visit receipt" };

export default async function Receipt({ params }: { params: Promise<{ ref: string }> }) {
  const actor = await requireActor("PROVIDER", "HMO");
  const { ref } = await params;
  if (!/^AUTH-[A-Z0-9]{8}$/.test(ref)) notFound();
  let r;
  try {
    r = await getReceipt(actor, ref);
  } catch (e) {
    return <div className="solo"><p>{errorMessage(e)}</p></div>;
  }
  return (
    <div className="solo">
      <span className="brand">HMO Access</span>
      <h1>Visit receipt</h1>
      <table>
        <tbody>
          <tr><th>Reference</th><td>{r.reference}</td></tr>
          <tr><th>Member</th><td>{r.member?.displayName} ({r.member?.memberRef})</td></tr>
          <tr><th>HMO</th><td>{r.hmoName}</td></tr>
          <tr><th>Provider</th><td>{r.providerName}, {r.locationName}</td></tr>
          <tr><th>Service</th><td>{r.benefitName}</td></tr>
          <tr><th>Authorized</th><td>{dt(r.authorizedAt)}</td></tr>
          <tr><th>Completed</th><td>{dt(r.completedAt)}</td></tr>
          <tr><th>Member co-payment</th><td>{r.memberCopay}</td></tr>
          <tr><th>Status</th><td>{r.status.toLowerCase()}</td></tr>
        </tbody>
      </table>
      <p className="small muted" style={{ marginTop: 16 }}>This receipt confirms the visit was recorded. It is not proof of payment between the HMO and the provider.</p>
      <PrintButton />
    </div>
  );
}
