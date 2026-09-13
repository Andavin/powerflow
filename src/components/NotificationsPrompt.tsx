"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/client/data";
import {
  canOfferPush,
  dismissPush,
  enablePush,
  isPushDismissed,
  pushPermission,
  resyncPush,
  type SubscriptionKeys,
} from "@/lib/client/push";

async function saveSubscription(sub: SubscriptionKeys): Promise<void> {
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });
  if (!res.ok) throw new Error(`subscribe failed (${res.status})`);
}

type Phase = "hidden" | "offer" | "busy" | "failed" | "on" | "testing" | "tested";

/**
 * Offers push notifications shortly after the app opens, as a card with a
 * button rather than the browser's own prompt: Safari needs a gesture for the
 * real ask, and a browser-level "deny" is permanent, so the cheap question
 * comes first. "Maybe later" hides it until the next sign-in (the login form
 * clears the flag). Once on, the card offers a test send for this session so
 * the whole chain — worker, permission, VAPID, push service, OS — can be seen
 * to work before an outage does it for real.
 */
export function NotificationsCard({ publicKey }: { publicKey: string | null }) {
  const [phase, setPhase] = useState<Phase>("hidden");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey || !canOfferPush()) return;
    const permission = pushPermission();
    if (permission === "granted") {
      // Already on: quietly make sure the server still has this browser.
      void resyncPush(publicKey, saveSubscription);
      return;
    }
    if (permission !== "default" || isPushDismissed()) return;
    // A beat after the page settles, so it doesn't read as a modal.
    const timer = setTimeout(() => setPhase("offer"), 1200);
    return () => clearTimeout(timer);
  }, [publicKey]);

  function later() {
    dismissPush();
    setPhase("hidden");
  }

  async function turnOn() {
    if (!publicKey) return;
    setPhase("busy");
    const result = await enablePush(publicKey, saveSubscription);
    if (result.ok) {
      setPhase("on");
      return;
    }
    if (result.reason === "FAILED") {
      setNote("Couldn't turn on notifications here.");
      setPhase("failed");
      return;
    }
    // Denied, or the browser's prompt was dismissed: nothing more can be asked.
    dismissPush();
    setPhase("hidden");
  }

  async function sendTest() {
    setPhase("testing");
    const res = await fetch("/api/push/test", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setNote(res.ok ? "Sent — check your lock screen." : body.error || "Test failed.");
    setPhase("tested");
  }

  if (phase === "hidden") return null;

  const enabled = phase === "on" || phase === "testing" || phase === "tested";
  return (
    <div
      role="status"
      className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm lg:mx-8 lg:mt-6"
    >
      <span>
        <span className="block font-medium">
          {enabled ? "Notifications are on." : "Get notified when the grid, battery, or collector needs attention?"}
        </span>
        <span className="block text-muted">
          {note ?? (enabled ? "You can send a test to make sure they arrive." : "Grid outages, a low battery, and the collector going quiet.")}
        </span>
      </span>
      <span className="flex gap-2">
        {enabled ? (
          <button
            onClick={sendTest}
            disabled={phase === "testing"}
            className="rounded-xl bg-surface-2 px-3 py-1.5 font-medium text-fg transition hover:bg-surface-3 disabled:opacity-40"
          >
            {phase === "testing" ? "Sending…" : "Send a test"}
          </button>
        ) : (
          <>
            <button onClick={later} disabled={phase === "busy"} className="rounded-xl px-3 py-1.5 text-muted transition hover:text-fg">
              Maybe later
            </button>
            <button
              onClick={turnOn}
              disabled={phase === "busy"}
              className="rounded-xl bg-battery px-3 py-1.5 font-semibold text-bg transition hover:opacity-90 disabled:opacity-40"
            >
              {phase === "busy" ? "Turning on…" : "Turn on"}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/** Fetches whether the server has a VAPID key; without one the card never shows. */
export function NotificationsPrompt() {
  const { data } = useSWR<{ publicKey: string | null }>("/api/push/config", fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  return <NotificationsCard publicKey={data?.publicKey ?? null} />;
}
