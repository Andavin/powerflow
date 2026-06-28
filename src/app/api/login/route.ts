import { cookies } from "next/headers";
import { config } from "@/lib/config";
import {
  SESSION_COOKIE,
  createSessionToken,
  passwordMatches,
} from "@/lib/auth";
import { jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const cfg = config();
  if (cfg.authDisabled) return Response.json({ ok: true });
  if (!cfg.password || !cfg.sessionSecret) {
    return jsonError("Login is not configured on the server", 500);
  }

  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body?.password === "string") password = body.password;
  } catch {
    return jsonError("Invalid request body", 400);
  }

  if (!passwordMatches(password, cfg.password)) {
    return jsonError("Incorrect password", 401);
  }

  const token = await createSessionToken(cfg.sessionSecret);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return Response.json({ ok: true });
}
