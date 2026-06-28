import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Liveness probe. Always 200 if the server is up; reports the data mode. */
export async function GET() {
  return Response.json({ status: "ok", mode: config().dataMode });
}
