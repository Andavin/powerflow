/**
 * Stateless session tokens for the login layer.
 *
 * A token is `v1.<issuedAtMs>.<hmac>` where the HMAC-SHA256 covers
 * `v1.<issuedAtMs>` using the configured session secret. Verification is done
 * with `crypto.subtle.verify` (constant-time). No server-side session store is
 * needed; rotating the secret invalidates every token.
 */

export const SESSION_COOKIE = "pf_session";
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSessionToken(
  secret: string,
  issuedAtMs: number = Date.now(),
): Promise<string> {
  const payload = `v1.${issuedAtMs}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined | null,
  opts: { maxAgeMs?: number; now?: number } = {},
): Promise<boolean> {
  if (!secret || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const [, issuedRaw, sigRaw] = parts;
  const issuedAt = Number(issuedRaw);
  if (!Number.isFinite(issuedAt)) return false;

  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  if (now - issuedAt > maxAge || issuedAt - now > 60_000) return false;

  let sig: Uint8Array;
  try {
    sig = b64urlDecode(sigRaw);
  } catch {
    return false;
  }
  const key = await hmacKey(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    sig as unknown as BufferSource,
    encoder.encode(`v1.${issuedRaw}`),
  );
}

/** Constant-time-ish password comparison (length-leaking only). */
export function passwordMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
