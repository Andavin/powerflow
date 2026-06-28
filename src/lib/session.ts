import "server-only";
import { cookies } from "next/headers";
import { config } from "./config";
import { SESSION_COOKIE, verifySessionToken } from "./auth";

/** Whether the current request carries a valid session (or auth is disabled). */
export async function isAuthenticated(): Promise<boolean> {
  const cfg = config();
  if (cfg.authDisabled) return true;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return verifySessionToken(cfg.sessionSecret, token);
}
