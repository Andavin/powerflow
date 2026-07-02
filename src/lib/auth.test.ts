import { describe, it, expect } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  passwordMatches,
  safeNextPath,
} from "./auth";

const SECRET = "a-sufficiently-long-test-secret-value";

describe("session tokens", () => {
  it("round-trips a valid token", async () => {
    const now = 1_700_000_000_000;
    const token = await createSessionToken(SECRET, now);
    expect(await verifySessionToken(SECRET, token, { now })).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken("other-secret", token)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const token = await createSessionToken(SECRET);
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    expect(await verifySessionToken(SECRET, tampered)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const issued = 1_700_000_000_000;
    const token = await createSessionToken(SECRET, issued);
    const now = issued + 40 * 24 * 60 * 60 * 1000; // 40 days later
    expect(await verifySessionToken(SECRET, token, { now })).toBe(false);
  });

  it("accepts a token at the exact max-age boundary", async () => {
    const issued = 1_700_000_000_000;
    const maxAgeMs = 60_000;
    const token = await createSessionToken(SECRET, issued);
    // Exact boundary: now - issued == maxAgeMs. The predicate is strict
    // greater-than, so this is still valid.
    expect(
      await verifySessionToken(SECRET, token, { now: issued + maxAgeMs, maxAgeMs }),
    ).toBe(true);
    expect(
      await verifySessionToken(SECRET, token, { now: issued + maxAgeMs + 1, maxAgeMs }),
    ).toBe(false);
  });

  it("rejects a token issued too far in the future (clock skew guard)", async () => {
    const now = 1_700_000_000_000;
    // Issued 61s in the future — beyond the 60s tolerance.
    const token = await createSessionToken(SECRET, now + 61_000);
    expect(await verifySessionToken(SECRET, token, { now })).toBe(false);
    // Just inside tolerance is fine.
    const nearFuture = await createSessionToken(SECRET, now + 30_000);
    expect(await verifySessionToken(SECRET, nearFuture, { now })).toBe(true);
  });

  it("rejects malformed tokens and empties", async () => {
    expect(await verifySessionToken(SECRET, "")).toBe(false);
    expect(await verifySessionToken(SECRET, "garbage")).toBe(false);
    expect(await verifySessionToken(SECRET, "v1.123")).toBe(false);
    expect(await verifySessionToken("", "v1.1.x")).toBe(false);
  });
});

describe("passwordMatches", () => {
  it("matches identical strings", async () => {
    expect(await passwordMatches("hunter2", "hunter2")).toBe(true);
  });
  it("rejects different strings and empty expected", async () => {
    expect(await passwordMatches("hunter2", "hunter3")).toBe(false);
    expect(await passwordMatches("x", "")).toBe(false);
    expect(await passwordMatches("short", "longer")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("returns / for empty / null / missing", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });
  it("honours a same-origin relative path", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/circuits")).toBe("/circuits");
    expect(safeNextPath("/circuits/abc?x=1")).toBe("/circuits/abc?x=1");
  });
  it("rejects protocol-relative URLs", () => {
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("//evil.com/circuits")).toBe("/");
  });
  it("rejects backslash-prefixed paths (browser-normalised to //)", () => {
    expect(safeNextPath("/\\evil.com")).toBe("/");
  });
  it("rejects absolute URLs and other schemes", () => {
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("http://evil.com/x")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    expect(safeNextPath("data:text/html,x")).toBe("/");
  });
  it("rejects paths that don't start with /", () => {
    expect(safeNextPath("circuits")).toBe("/");
    expect(safeNextPath(" /circuits")).toBe("/");
  });
});
