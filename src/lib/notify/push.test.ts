import { describe, it, expect, vi, beforeEach } from "vitest";
import { PushSender } from "./push";
import type { PushSubscriptionRecord } from "./store";

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();
vi.mock("web-push", () => ({ default: { sendNotification, setVapidDetails } }));

const vapid = { subject: "mailto:x@y", publicKey: "pub", privateKey: "priv" };
const payload = { title: "t", body: "b", path: "/", tag: "test" };
const rec = (endpoint: string): PushSubscriptionRecord => ({ endpoint, p256dh: "p", auth: "a", createdAt: "now" });

function fakeStore(initial: PushSubscriptionRecord[]) {
  const rows = [...initial];
  return {
    rows,
    list: vi.fn(async () => [...rows]),
    remove: vi.fn(async (endpoint: string) => {
      const i = rows.findIndex((r) => r.endpoint === endpoint);
      if (i >= 0) rows.splice(i, 1);
    }),
  };
}

beforeEach(() => {
  sendNotification.mockReset();
  setVapidDetails.mockReset();
});

describe("PushSender", () => {
  it("is a no-op with no VAPID keys", async () => {
    const store = fakeStore([rec("https://p/1")]);
    const sent = await new PushSender(null, store).sendToAll(payload);
    expect(sent).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("sends the payload to every subscription and reports the count", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const store = fakeStore([rec("https://p/1"), rec("https://p/2")]);
    const sent = await new PushSender(vapid, store).sendToAll(payload);
    expect(sent).toBe(2);
    expect(setVapidDetails).toHaveBeenCalledWith("mailto:x@y", "pub", "priv");
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const [subscription, body] = sendNotification.mock.calls[0];
    expect(subscription).toEqual({ endpoint: "https://p/1", keys: { p256dh: "p", auth: "a" } });
    expect(JSON.parse(body)).toEqual(payload);
  });

  it("forgets a subscription the push service says is gone (404/410)", async () => {
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === "https://p/dead") throw Object.assign(new Error("gone"), { statusCode: 410 });
      return { statusCode: 201 };
    });
    const store = fakeStore([rec("https://p/dead"), rec("https://p/ok")]);
    const sent = await new PushSender(vapid, store).sendToAll(payload);
    expect(sent).toBe(1);
    expect(store.remove).toHaveBeenCalledWith("https://p/dead");
    expect(store.rows.map((r) => r.endpoint)).toEqual(["https://p/ok"]);
  });

  it("logs any other failure and keeps the subscription", async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = fakeStore([rec("https://p/1")]);
    const sent = await new PushSender(vapid, store).sendToAll(payload);
    expect(sent).toBe(0);
    expect(store.remove).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("403"), expect.anything());
    error.mockRestore();
  });
});
