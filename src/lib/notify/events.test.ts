import { describe, it, expect } from "vitest";
import { payloadFor, TEST_PAYLOAD, type NotifyEvent } from "./events";

describe("payloadFor", () => {
  it("gives every event a title, body, and same-origin path", () => {
    const kinds: NotifyEvent[] = [
      { kind: "DATA_STALE", ageSeconds: 420, table: "power_flows" },
      { kind: "DATA_RESUMED" },
      { kind: "GRID_DOWN" },
      { kind: "GRID_RESTORED" },
      { kind: "BATTERY_LOW", soc: 18 },
    ];
    for (const e of kinds) {
      const p = payloadFor(e);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.body.length).toBeGreaterThan(0);
      expect(p.path.startsWith("/")).toBe(true);
    }
  });

  it("pairs an outage with its recovery under one tag so the recovery replaces it", () => {
    expect(payloadFor({ kind: "GRID_DOWN" }).tag).toBe(payloadFor({ kind: "GRID_RESTORED" }).tag);
    expect(payloadFor({ kind: "DATA_STALE", ageSeconds: 300 }).tag).toBe(
      payloadFor({ kind: "DATA_RESUMED" }).tag,
    );
    expect(payloadFor({ kind: "BATTERY_LOW", soc: 10 }).tag).not.toBe(payloadFor({ kind: "GRID_DOWN" }).tag);
  });

  it("puts the numbers in the words", () => {
    expect(payloadFor({ kind: "BATTERY_LOW", soc: 18 }).body).toContain("18%");
    expect(payloadFor({ kind: "DATA_STALE", ageSeconds: 420, table: "power_flows" }).body).toContain("7m");
  });

  it("has a test payload with its own tag so a test never collapses a real alert", () => {
    const real = new Set(["data", "grid", "battery"].map((t) => t));
    expect(real.has(TEST_PAYLOAD.tag)).toBe(false);
  });
});
