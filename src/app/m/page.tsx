import { MemberPortal } from "./MemberPortal";
import { SmsBanner } from "@/components/SmsBanner";

export const metadata = { title: "My benefits" };

export const dynamic = "force-dynamic";

export default function MemberPage() {
  return (
    <>
    <SmsBanner />
    <div className="solo">
      <span className="brand">HMO Access</span>
      <MemberPortal />
    </div>
    </>
  );
}
