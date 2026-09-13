import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { NotificationsCard } from "./NotificationsPrompt";

// A browser that can do push: secure context, a worker, PushManager, and a
// Notification with a permission we control per test.
const backing = new Map<string, string>();
const subscription = {
  endpoint: "https://push.example/abc",
  toJSON: () => ({ keys: { p256dh: "P", auth: "A" } }),
};
const registration = {
  pushManager: {
    getSubscription: vi.fn(async () => null),
    subscribe: vi.fn(async () => subscription),
  },
};
const notification = { permission: "default" as NotificationPermission, requestPermission: vi.fn(async () => "granted") };
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));

beforeEach(() => {
  vi.useFakeTimers();
  backing.clear();
  notification.permission = "default";
  notification.requestPermission.mockResolvedValue("granted");
  fetchMock.mockClear();
  registration.pushManager.subscribe.mockClear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "serviceWorker", {
    value: { register: vi.fn(async () => registration), ready: Promise.resolve(registration) },
    configurable: true,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = () => act(() => vi.advanceTimersByTimeAsync(1500));
// Fake timers stall testing-library's waitFor; flush microtasks explicitly instead.
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("NotificationsCard", () => {
  it("shows the offer a beat after load", async () => {
    render(<NotificationsCard publicKey="key" />);
    expect(screen.queryByRole("status")).toBeNull();
    await settle();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });

  it("never shows without a server key, in an insecure context, or once answered", async () => {
    const { unmount } = render(<NotificationsCard publicKey={null} />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    unmount();

    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const r2 = render(<NotificationsCard publicKey="key" />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    r2.unmount();
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });

    notification.permission = "denied";
    render(<NotificationsCard publicKey="key" />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("'Maybe later' hides it and is remembered until the flag is cleared", async () => {
    const { unmount } = render(<NotificationsCard publicKey="key" />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Maybe later" }));
    expect(screen.queryByRole("status")).toBeNull();
    unmount();

    render(<NotificationsCard publicKey="key" />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("'Turn on' asks, subscribes, saves, then offers a test", async () => {
    render(<NotificationsCard publicKey="key" />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await flush();
    expect(screen.getByText("Notifications are on.")).toBeInTheDocument();

    expect(notification.requestPermission).toHaveBeenCalled();
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/push/subscribe");
    expect(JSON.parse(String(init?.body))).toEqual({ endpoint: "https://push.example/abc", p256dh: "P", auth: "A" });

    fireEvent.click(screen.getByRole("button", { name: "Send a test" }));
    await flush();
    expect(screen.getByText(/check your lock screen/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/push/test");
  });

  it("hides for good when the browser's prompt is refused", async () => {
    notification.requestPermission.mockResolvedValue("denied");
    render(<NotificationsCard publicKey="key" />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
    expect(backing.get("powerflow-push-dismissed")).toBe("1");
  });

  it("re-posts the subscription silently when permission was already granted", async () => {
    notification.permission = "granted";
    render(<NotificationsCard publicKey="key" />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/push/subscribe", expect.anything());
  });
});
