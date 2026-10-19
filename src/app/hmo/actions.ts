"use server";
import { applyHeldRows, applyImport, cancelImport } from "@/lib/server/services/imports";
import type { SyncSummary } from "@/lib/server/services/member-sync";
import { createBenefit, createPlan, createPlanVersion, publishBenefitVersion, publishPlanVersion } from "@/lib/server/services/catalog";
import { revokeCredential, setMemberStatus } from "@/lib/server/services/members";
import { setNetworkLocation, setTariff, upsertContract } from "@/lib/server/services/network";
import { adjustClaim, approveClaim, rejectClaim, startReview } from "@/lib/server/services/claims";
import { assignCredit, issuePaymentInstructions, resolveCredit, resolveSettlementException } from "@/lib/server/services/payments";
import { approveSettlement, cancelSettlement, createSettlement, recordPayment, reconcileSettlement } from "@/lib/server/services/settlements";
import { createServiceApproval, revokeServiceApproval } from "@/lib/server/services/approvals";
import { inviteStaff, setStaffStatus } from "@/lib/server/services/organizations";
import { nairaToMinor, requireActor, runAction, str } from "@/lib/server/web";

const hmo = () => requireActor("HMO");
const back = (fd: FormData, fallback: string) => {
  const b = str(fd, "back");
  return b.startsWith("/hmo") ? b : fallback;
};

export async function applyImportAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/imports", async () => {
    const r = await applyImport(a, str(fd, "id"), { acceptIdentityChanges: str(fd, "acceptIdentityChanges") === "on" });
    if (r.status === "QUEUED" || r.status === "PROCESSING") return "Large file: it is being applied in the background. This page shows progress; refresh to update.";
    if (r.idempotentReplay) return "This file was already applied; nothing changed";
    return importResultMessage(r.status, r.summary, r.progress);
  });
}
export async function applyHeldImportAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/imports", async () => {
    const j = await applyHeldRows(a, str(fd, "id"));
    return j.status === "QUEUED" || j.status === "PROCESSING" ? "Name changes accepted; applying in the background" : importResultMessage(j.status, j.summary as SyncSummary, j.progress);
  });
}
function importResultMessage(status: string, s: SyncSummary | null, p: { appliedRows: number; heldRows: number; failedRows: number }) {
  const base = s ? `${s.membersCreated} new members, ${s.membersUpdated} updated, ${s.coverageCreated} new coverage records` : `${p.appliedRows} rows applied`;
  const held = p.heldRows ? ` ${p.heldRows} row(s) would change a member's name and are held for your review.` : "";
  const failed = p.failedRows ? ` ${p.failedRows} row(s) could not be applied — download the report.` : "";
  const retro = s?.retroactiveConflicts?.length ? ` ${s.retroactiveConflicts.length} past visits fall outside the corrected coverage — review their claims.` : "";
  return `${status === "APPLIED" ? "Applied" : status === "FAILED" ? "Not applied" : "Partly applied"}: ${base}.${held}${failed}${retro}`;
}
export async function cancelImportAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/imports", async () => {
    await cancelImport(a, str(fd, "id"));
    return "Upload discarded";
  });
}
export async function memberStatusAction(fd: FormData) {
  const a = await hmo();
  const id = str(fd, "id");
  await runAction(`/hmo/members/${id}`, async () => {
    await setMemberStatus(a, id, str(fd, "status") as "ACTIVE", str(fd, "reason"));
    return "Member status updated";
  });
}
export async function revokeCredentialAction(fd: FormData) {
  const a = await hmo();
  await runAction(back(fd, "/hmo/members"), async () => {
    await revokeCredential(a, str(fd, "id"), str(fd, "reason") || "Revoked by HMO");
    return "Card code revoked. It will no longer scan.";
  });
}
export async function createApprovalAction(fd: FormData) {
  const a = await hmo();
  const memberId = str(fd, "memberId");
  await runAction(`/hmo/members/${memberId}`, async () => {
    const r = await createServiceApproval(a, {
      memberId,
      benefitId: str(fd, "benefitId"),
      type: str(fd, "type") as "REFERRAL",
      providerOrgId: str(fd, "providerOrgId") || null,
      validFrom: new Date(str(fd, "validFrom") || Date.now()),
      validTo: new Date(str(fd, "validTo")),
    });
    return `${r.type === "REFERRAL" ? "Referral" : "Pre-authorization"} ${r.reference} issued`;
  });
}
export async function revokeApprovalAction(fd: FormData) {
  const a = await hmo();
  await runAction(back(fd, "/hmo/members"), async () => {
    await revokeServiceApproval(a, str(fd, "id"));
    return "Approval revoked";
  });
}
export async function createPlanAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/plans", async () => {
    const p = await createPlan(a, { code: str(fd, "code"), name: str(fd, "name") });
    return `Plan ${p.code} created. Add a version to choose its benefits.`;
  });
}
export async function createPlanVersionAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/plans", async () => {
    const benefitIds = fd.getAll("benefitIds").map(String);
    const v = await createPlanVersion(a, str(fd, "planId"), {
      effectiveFrom: new Date(str(fd, "effectiveFrom")),
      notes: str(fd, "notes") || undefined,
      benefits: benefitIds.map((id) => ({ benefitId: id, memberGroups: str(fd, `groups_${id}`).split(",").map((g) => g.trim()).filter(Boolean) })),
    });
    return `Draft version ${v.version} created. Publish it to put it into effect.`;
  });
}
export async function publishPlanVersionAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/plans", async () => {
    const v = await publishPlanVersion(a, str(fd, "id"));
    return `Version ${v.version} published`;
  });
}
export async function createBenefitAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/benefits", async () => {
    const b = await createBenefit(a, { code: str(fd, "code"), name: str(fd, "name"), category: str(fd, "category"), description: str(fd, "description") || undefined });
    return `Benefit ${b.code} created. Set its rules to make it usable.`;
  });
}
export async function publishBenefitVersionAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/benefits", async () => {
    const v = await publishBenefitVersion(a, str(fd, "id"));
    return `Rules version ${v.version} published`;
  });
}
export async function contractAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/network", async () => {
    await upsertContract(a, { providerOrgId: str(fd, "providerOrgId"), status: str(fd, "status") as "APPROVED", settlementTermsDays: Number(str(fd, "settlementTermsDays") || 30), settlementTermsNotes: str(fd, "notes") || undefined });
    return "Provider agreement saved";
  });
}
export async function locationAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/network", async () => {
    await setNetworkLocation(a, str(fd, "locationId"), str(fd, "status") as "APPROVED");
    return "Branch updated";
  });
}
export async function tariffAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/network", async () => {
    const t = await setTariff(a, { providerOrgId: str(fd, "providerOrgId"), benefitId: str(fd, "benefitId"), locationId: str(fd, "locationId") || null, tariffMinor: nairaToMinor(str(fd, "tariff")) });
    return `Tariff set to ₦${(t.tariffMinor / 100).toLocaleString("en-NG")} from now`;
  });
}
export async function claimAction(fd: FormData) {
  const a = await hmo();
  const id = str(fd, "id");
  const op = str(fd, "op");
  await runAction(back(fd, "/hmo/claims"), async () => {
    if (op === "review") {
      const c = await startReview(a, id);
      return `Claim ${c.reference} is under review`;
    }
    if (op === "approve") {
      const c = await approveClaim(a, id);
      return `Claim ${c.reference} approved for ₦${((c.approvedAmountMinor ?? 0) / 100).toLocaleString("en-NG")}`;
    }
    if (op === "reject") {
      const c = await rejectClaim(a, id, { reason: str(fd, "reason"), restoreAllowance: fd.get("restore") === "on" });
      return `Claim ${c.reference} rejected`;
    }
    if (op === "adjust") {
      const sign = str(fd, "direction") === "increase" ? 1 : -1;
      const r = await adjustClaim(a, id, { deltaMinor: sign * nairaToMinor(str(fd, "amount")), reason: str(fd, "reason") });
      return `Adjustment recorded; payable is now ₦${(r.payableAfterAdjustmentsMinor / 100).toLocaleString("en-NG")}`;
    }
    return "Nothing to do";
  });
}
export async function createSettlementAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/settlements", async () => {
    const s = await createSettlement(a, { providerOrgId: str(fd, "providerOrgId") });
    return `Settlement ${s.reference} drafted for ₦${(s.totalMinor / 100).toLocaleString("en-NG")}`;
  });
}
export async function settlementAction(fd: FormData) {
  const a = await hmo();
  const id = str(fd, "id");
  const op = str(fd, "op");
  await runAction("/hmo/settlements", async () => {
    if (op === "approve") return `Settlement ${(await approveSettlement(a, id)).reference} approved for payment`;
    if (op === "instructions") {
      const r = await issuePaymentInstructions(a, id);
      return `Pay ${r.settlement.reference} into account ${r.instructions?.accountNumber} (${r.instructions?.bankName}). The bank confirms it automatically.`;
    }
    if (op === "resolve-exception") return `${(await resolveSettlementException(a, id, str(fd, "resolution"))).reference} resolved`;
    if (op === "cancel") return `Settlement ${(await cancelSettlement(a, id, str(fd, "reason") || "Cancelled")).reference} cancelled; its claims can be settled again`;
    if (op === "pay") {
      const s = await recordPayment(a, id, { paymentReference: str(fd, "paymentReference"), amountMinor: nairaToMinor(str(fd, "amount")), paidAt: new Date(str(fd, "paidAt") || Date.now()) });
      return `Payment ${s.paymentReference} recorded`;
    }
    if (op === "reconcile") {
      const s = await reconcileSettlement(a, id, { statementReference: str(fd, "statementReference"), confirmedAmountMinor: nairaToMinor(str(fd, "amount")) });
      return s.status === "RECONCILED" ? `${s.reference} reconciled; its claims are settled` : `${s.reference}: the statement amount does not match. Claims stay unsettled until it does.`;
    }
    return "Nothing to do";
  });
}
export async function creditAction(fd: FormData) {
  const a = await hmo();
  const id = str(fd, "id");
  await runAction("/hmo/settlements", async () => {
    if (str(fd, "op") === "assign") {
      await assignCredit(a, id, str(fd, "settlementId"));
      return "Transfer assigned; the payment status has been updated";
    }
    await resolveCredit(a, id, str(fd, "resolution"));
    return "Recorded how this transfer was handled";
  });
}
export async function inviteHmoStaffAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/staff", async () => {
    const r = await inviteStaff(a, { email: str(fd, "email"), name: str(fd, "name"), roleKey: str(fd, "roleKey") });
    return r.temporaryPassword ? `Added ${r.email}. Temporary password (shown once): ${r.temporaryPassword}` : `Added ${r.email} (existing account)`;
  });
}
export async function hmoStaffStatusAction(fd: FormData) {
  const a = await hmo();
  await runAction("/hmo/staff", async () => {
    await setStaffStatus(a, str(fd, "id"), str(fd, "status") as "ACTIVE");
    return "Staff access updated";
  });
}
