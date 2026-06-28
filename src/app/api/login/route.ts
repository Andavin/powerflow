import { cookies } from "next/headers";
import { config } from "@/lib/config";
import {
  SESSION_COOKIE,
  createSessionToken,
  passwordMatches,
} from "@/lib/auth";
import { jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Whether to mark the session cookie `Secure`.
 *
 * A `Secure` cookie is silently dropped by the browser over plain HTTP, which
 * would make login appear to "do nothing". So we only set it when the request
 * actually arrived over HTTPS — detected via the proxy's `x-forwarded-proto`
 * (the common reverse-proxy setup) or the request URL. Set
 * `POWERFLOW_FORCE_INSECURE_COOKIE=1` to never mark it secure.
 */
function cookieSecure(request: Request): boolean {
  if (process.env.POWERFLOW_FORCE_INSECURE_COOKIE === "1") return false;
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

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
    secure: cookieSecure(request),
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return Response.json({ ok: true });
}
