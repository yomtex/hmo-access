import { Shell } from "@/components/Shell";
import { requireActor } from "@/lib/server/web";

export default async function HmoLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor("HMO");
  return <Shell actor={actor}>{children}</Shell>;
}
