import { describe, it, expect, beforeEach, vi } from "vitest";
import { decodeKey, canOfferPush, isPushDismissed, dismissPush, clearPushDismissal } from "./push";

// Node 25 ships its own (inert) localStorage global that shadows jsdom's, so
// back it with a plain map for the test.
const backing = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
});

describe("decodeKey", () => {
  it("decodes base64url without padding into raw bytes", () => {
    // "hello" → aGVsbG8 (base64url, no padding)
    expect(Array.from(decodeKey("aGVsbG8"))).toEqual([104, 101, 108, 108, 111]);
    expect(decodeKey("-_8").length).toBe(2); // '-' and '_' are the url-safe alphabet
  });
});

describe("dismissal", () => {
  beforeEach(() => backing.clear());

  it("is remembered until cleared", () => {
    expect(isPushDismissed()).toBe(false);
    dismissPush();
    expect(isPushDismissed()).toBe(true);
    clearPushDismissal();
    expect(isPushDismissed()).toBe(false);
  });
});

describe("canOfferPush", () => {
  it("is false in a browser without push (jsdom)", () => {
    expect(canOfferPush()).toBe(false);
  });
});
