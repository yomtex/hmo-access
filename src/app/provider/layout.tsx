import { Shell } from "@/components/Shell";
import { requireActor } from "@/lib/server/web";

export default async function ProviderLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor("PROVIDER");
  return <Shell actor={actor}>{children}</Shell>;
}
