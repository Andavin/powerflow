import { describe, it, expect } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  passwordMatches,
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

  it("rejects malformed tokens and empties", async () => {
    expect(await verifySessionToken(SECRET, "")).toBe(false);
    expect(await verifySessionToken(SECRET, "garbage")).toBe(false);
    expect(await verifySessionToken(SECRET, "v1.123")).toBe(false);
    expect(await verifySessionToken("", "v1.1.x")).toBe(false);
  });
});

describe("passwordMatches", () => {
  it("matches identical strings", () => {
    expect(passwordMatches("hunter2", "hunter2")).toBe(true);
  });
  it("rejects different strings and empty expected", () => {
    expect(passwordMatches("hunter2", "hunter3")).toBe(false);
    expect(passwordMatches("x", "")).toBe(false);
    expect(passwordMatches("short", "longer")).toBe(false);
  });
});
