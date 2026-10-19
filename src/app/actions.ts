"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { changePassword, login, logout, resolveSession, selectLocation, SESSION_COOKIE } from "@/lib/server/auth/session";
import { config } from "@/lib/server/config";
import { AppError } from "@/lib/server/errors";
import { errorMessage, homeFor, requestIp, requireActor, runAction, str } from "@/lib/server/web";

export async function loginAction(fd: FormData) {
  let target = "/";
  try {
    const { token } = await login(str(fd, "email"), String(fd.get("password") ?? ""), await requestIp());
    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config().NODE_ENV === "production", path: "/", maxAge: config().SESSION_TTL_HOURS * 3600 });
    const actor = await resolveSession(token);
    target = actor ? homeFor(actor) : "/";
  } catch (e) {
    target = `/login?err=${encodeURIComponent(errorMessage(e))}`;
  }
  redirect(target);
}

export async function logoutAction() {
  const jar = await cookies();
  const t = jar.get(SESSION_COOKIE)?.value;
  if (t) await logout(t);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

export async function selectBranchAction(fd: FormData) {
  const jar = await cookies();
  const actor = await resolveSession(jar.get(SESSION_COOKIE)?.value);
  if (!actor) redirect("/login");
  const next = str(fd, "next") === "/reception" ? "/reception" : "/provider";
  let target = next;
  try {
    await selectLocation(actor, str(fd, "locationId"));
  } catch (e) {
    target = `${next}?err=${encodeURIComponent(errorMessage(e))}`;
  }
  redirect(target);
}

export async function changePasswordAction(fd: FormData) {
  const actor = await requireActor();
  await runAction("/account", async () => {
    const next = String(fd.get("newPassword") ?? "");
    if (next !== String(fd.get("confirmPassword") ?? "")) throw new AppError("VALIDATION_FAILED", "The new passwords don't match");
    await changePassword(actor, String(fd.get("currentPassword") ?? ""), next);
    return "Password changed. Other devices have been signed out.";
  });
}
