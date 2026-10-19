import Link from "next/link";
import { redirect } from "next/navigation";
import { loginAction } from "../actions";
import { currentActor, homeFor } from "@/lib/server/web";
import type { SP } from "@/lib/format";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const actor = await currentActor();
  if (actor) redirect(homeFor(actor));
  const sp = await searchParams;
  return (
    <div className="solo">
      <Link className="brand" href="/">HMO Access</Link>
      <h1>Sign in</h1>
      <p className="muted">For HMO staff, provider staff and platform administrators. Members don&apos;t need an account — use <Link href="/m">your benefits page</Link>.</p>
      {sp.err && <div className="flash err" role="alert">{sp.err}</div>}
      <form action={loginAction} className="panel">
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
