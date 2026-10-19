import { handle } from "@/lib/server/api/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) => handle(req);
export const POST = (req: Request) => handle(req);
export const PUT = (req: Request) => handle(req);
export const DELETE = (req: Request) => handle(req);
