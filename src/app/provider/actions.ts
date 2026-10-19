"use server";
import { cancelAuthorization, completeVisit } from "@/lib/server/services/visits";
import { disputeClaim, submitClaim } from "@/lib/server/services/claims";
import { providerConfirmReceipt } from "@/lib/server/services/settlements";
import { addPayoutAccount, cancelPayoutChange } from "@/lib/server/services/payments";
import { createLocation, inviteStaff, setStaffStatus } from "@/lib/server/services/organizations";
import { requireActor, runAction, str } from "@/lib/server/web";

export async function completeVisitAction(fd: FormData) {
  const actor = await requireActor("PROVIDER");
  await runAction("/provider/visits", async () => {
    const r = await completeVisit(actor, str(fd, "id"), { attendanceConfirmed: fd.get("attended") === "on", notes: str(fd, "notes") || undefined, submitClaim: true });
    return `Visit ${r.authorization.reference} completed${r.claim ? `; claim ${r.claim.reference} submitted` : ""}`;
  });
}
export async function cancelVisitAction(fd: FormData) {
  const actor = await requireActor("PROVIDER");
  await runAction("/provider/visits", async () => {
    const r = await cancelAuthorization(actor, str(fd, "id"), str(fd, "reason") || "Cancelled at front desk");
    return `Visit ${r.reference} cancelled; the member's allowance was released`;
  });
}
export async function submitClaimAction(fd: FormData) {
  const actor = await requireActor("PROVIDER");
  await runAction("/provider/visits", async () => {
    const c = await submitClaim(actor, str(fd, "id"), { attendanceConfirmed: true, notes: str(fd, "notes") || undefined });
    return `Claim ${c.reference} submitted`;
  });
}
export async function disputeClaimAction(fd: FormData) {
  const actor = await requireActor("PROVIDER");
  await runAction("/provider/claims", async () => {
    const c = await disputeClaim(actor, str(fd, "id"), { reason: str(fd, "reason") });
    return `Claim ${c.reference} disputed`;
  });
}
export async function confirmReceiptAction(fd: FormData) {
  const actor = await requireActor("PROVIDER");
  await runAction("/provider/settlements", async () => {
    const s = await providerConfirmReceipt(actor, str(fd, "id"));
    return `Receipt of ${s.reference} confirmed`;
  });
}
export async function payoutAction(fd: FormData) {
  const actor = await requireActor("PROVIDER");
  await runAction("/provider/settlements", async () => {
    if (str(fd, "op") === "cancel") {
      await cancelPayoutChange(actor, str(fd, "id"));
      return "Pending bank account change cancelled";
    }
    const p = await addPayoutAccount(actor, { bankCode: str(fd, "bankCode"), accountNumber: str(fd, "accountNumber"), password: str(fd, "password") });
    if (p.status === "ACTIVE") return `Payments will go to ${p.bankName} •••• ${p.accountLast4} (${p.resolvedName})`;
    if (p.status === "SCHEDULED") return `${p.bankName} •••• ${p.accountLast4} (${p.resolvedName}) takes over on ${new Date(p.activeFrom!).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}. Your HMOs have been told.`;
    return `The bank says this account belongs to "${p.resolvedName}", which doesn't match your registered name. HMO Access will review it before any money goes there.`;
  });
}
export async function inviteProviderStaffAction(fd: FormData) {
  const actor = await requireActor("PROVIDER");
  await runAction("/provider/staff", async () => {
    const r = await inviteStaff(actor, { email: str(fd, "email"), name: str(fd, "name"), roleKey: str(fd, "roleKey"), locationIds: fd.getAll("locationIds").map(String) });
    return r.temporaryPassword ? `Added ${r.email}. Temporary password (shown once): ${r.temporaryPassword}` : `Added ${r.email} (existing account)`;
  });
}
export async function providerStaffStatusAction(fd: FormData) {
  const actor = await requireActor("PROVIDER");
  await runAction("/provider/staff", async () => {
    await setStaffStatus(actor, str(fd, "id"), str(fd, "status") as "ACTIVE" | "INACTIVE");
    return "Staff access updated";
  });
}
export async function addLocationAction(fd: FormData) {
  const actor = await requireActor("PROVIDER");
  await runAction("/provider/staff", async () => {
    const l = await createLocation(actor, { name: str(fd, "name"), address: str(fd, "address") || undefined, city: str(fd, "city") || undefined });
    return `Branch ${l.name} added. Ask each HMO to approve it before members can be verified there.`;
  });
}
