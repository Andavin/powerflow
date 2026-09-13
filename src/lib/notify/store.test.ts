import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubscriptionStore, parseSubscription } from "./store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pf-push-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sub = (endpoint: string, keys = "k") => ({ endpoint, p256dh: `p-${keys}`, auth: `a-${keys}` });

describe("SubscriptionStore", () => {
  it("starts empty when the file (or the directory) doesn't exist", async () => {
    const store = new SubscriptionStore(join(dir, "nested", "does-not-exist"));
    expect(await store.list()).toEqual([]);
  });

  it("persists a subscription and reads it back in a fresh instance", async () => {
    await new SubscriptionStore(dir).upsert(sub("https://push.example/a"));
    const again = await new SubscriptionStore(dir).list();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject(sub("https://push.example/a"));
    expect(typeof again[0].createdAt).toBe("string");
  });

  it("replaces the keys of an existing endpoint rather than adding a row", async () => {
    const store = new SubscriptionStore(dir);
    await store.upsert(sub("https://push.example/a", "old"));
    await store.upsert(sub("https://push.example/a", "new"));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].p256dh).toBe("p-new");
  });

  it("removes by endpoint and tolerates removing something already gone", async () => {
    const store = new SubscriptionStore(dir);
    await store.upsert(sub("https://push.example/a"));
    await store.upsert(sub("https://push.example/b"));
    await store.remove("https://push.example/a");
    await store.remove("https://push.example/a");
    expect((await store.list()).map((s) => s.endpoint)).toEqual(["https://push.example/b"]);
  });

  it("creates the directory on first write", async () => {
    const nested = join(dir, "a", "b");
    await new SubscriptionStore(nested).upsert(sub("https://push.example/a"));
    expect(readdirSync(nested)).toContain("push-subscriptions.json");
  });

  it("leaves no temp file behind after a write", async () => {
    await new SubscriptionStore(dir).upsert(sub("https://push.example/a"));
    expect(readdirSync(dir)).toEqual(["push-subscriptions.json"]);
    expect(JSON.parse(readFileSync(join(dir, "push-subscriptions.json"), "utf8"))).toHaveLength(1);
  });

  it("treats a corrupt file as empty and says so, instead of crashing", async () => {
    writeFileSync(join(dir, "push-subscriptions.json"), "{not json");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await new SubscriptionStore(dir).list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("parseSubscription", () => {
  it("accepts the shape PushManager.subscribe() produces", () => {
    expect(parseSubscription({ endpoint: "https://push.example/x", p256dh: "k", auth: "a" })).toEqual({
      endpoint: "https://push.example/x",
      p256dh: "k",
      auth: "a",
    });
  });

  it("rejects anything the server would later refuse to send to", () => {
    expect(parseSubscription(null)).toBeNull();
    expect(parseSubscription({ endpoint: "http://push.example/x", p256dh: "k", auth: "a" })).toBeNull();
    expect(parseSubscription({ endpoint: "not a url", p256dh: "k", auth: "a" })).toBeNull();
    expect(parseSubscription({ endpoint: "https://push.example/x", p256dh: "", auth: "a" })).toBeNull();
    expect(parseSubscription({ endpoint: "https://push.example/x", p256dh: "k" })).toBeNull();
  });
});
