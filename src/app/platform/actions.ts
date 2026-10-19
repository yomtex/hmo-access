"use server";
import { createHmo, createProvider, setOrganizationStatus } from "@/lib/server/services/organizations";
import { upsertIntegration } from "@/lib/server/services/integrations";
import { expireStale } from "@/lib/server/services/visits";
import { resolveCredit, reviewPayoutAccount } from "@/lib/server/services/payments";
import { requireActor, runAction, str } from "@/lib/server/web";

export async function createHmoAction(fd: FormData) {
  const a = await requireActor("PLATFORM");
  await runAction("/platform", async () => {
    const r = await createHmo(a, { name: str(fd, "name"), slug: str(fd, "slug"), contactEmail: str(fd, "contactEmail") || undefined, admin: { email: str(fd, "adminEmail"), name: str(fd, "adminName") } });
    return `${r.organization.name} onboarded. ${r.admin.temporaryPassword ? `Admin ${r.admin.email}, temporary password (shown once): ${r.admin.temporaryPassword}` : `Existing user ${r.admin.email} added as admin.`}`;
  });
}
export async function createProviderAction(fd: FormData) {
  const a = await requireActor("PLATFORM");
  await runAction("/platform", async () => {
    const locations = str(fd, "locations").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, city] = l.split(",").map((x) => x.trim());
      return { name, city };
    });
    const r = await createProvider(a, { name: str(fd, "name"), slug: str(fd, "slug"), providerType: str(fd, "providerType"), locations, admin: { email: str(fd, "adminEmail"), name: str(fd, "adminName") } });
    return `${r.organization.name} onboarded with ${r.locations.length} branches. ${r.admin.temporaryPassword ? `Admin ${r.admin.email}, temporary password (shown once): ${r.admin.temporaryPassword}` : ""}`;
  });
}
export async function orgStatusAction(fd: FormData) {
  const a = await requireActor("PLATFORM");
  await runAction("/platform", async () => {
    const o = await setOrganizationStatus(a, str(fd, "id"), str(fd, "status") as "ACTIVE", str(fd, "reason") || "Platform admin action");
    return `${o.name} is now ${o.status.toLowerCase()}`;
  });
}
export async function integrationAction(fd: FormData) {
  const a = await requireActor("PLATFORM");
  await runAction("/platform/integrations", async () => {
    let config: Record<string, unknown> = {};
    const raw = str(fd, "config");
    if (raw) config = JSON.parse(raw);
    const r = await upsertIntegration(a, { hmoOrgId: str(fd, "hmoOrgId"), kind: str(fd, "kind") as "WEBHOOK", name: str(fd, "name"), status: str(fd, "status") as "DISABLED", config, secretRef: str(fd, "secretRef") || undefined }, str(fd, "id") || undefined);
    return `Integration ${r.name} saved`;
  });
}
export async function housekeepingAction() {
  await requireActor("PLATFORM");
  await runAction("/platform", async () => {
    const r = await expireStale();
    return `Expired ${r.intentsExpired} visit requests and ${r.authorizationsExpired} uncompleted authorizations`;
  });
}

export async function payoutReviewAction(fd: FormData) {
  const a = await requireActor("PLATFORM");
  await runAction("/platform/payments", async () => {
    const p = await reviewPayoutAccount(a, str(fd, "id"), { decision: str(fd, "decision") as "APPROVE", note: str(fd, "note") });
    return `Payout account •••• ${p.accountLast4} is now ${p.status.toLowerCase().replace("_", " ")}`;
  });
}
export async function platformCreditAction(fd: FormData) {
  const a = await requireActor("PLATFORM");
  await runAction("/platform/payments", async () => {
    await resolveCredit(a, str(fd, "id"), str(fd, "resolution"));
    return "Recorded";
  });
}
