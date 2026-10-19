import { Shell } from "@/components/Shell";
import { requireActor } from "@/lib/server/web";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor("PLATFORM");
  return <Shell actor={actor}>{children}</Shell>;
}
