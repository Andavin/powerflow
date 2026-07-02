import type { NextRequest } from "next/server";
import { getLiveSource } from "@/lib/live/getLiveSource";
import type { LiveSnapshot } from "@/lib/live/types";
import { isAuthenticated } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of live flow + top-consumer snapshots.
 *
 * Backed by a shared live source (MQTT when configured, else QuestDB polling),
 * so every connected client rides one upstream feed. Emits a `flow` event and a
 * `top` event per coalesced snapshot.
 */
export async function GET(request: NextRequest) {
  // Defence-in-depth: the proxy already gates this, but don't start/subscribe
  // to the live feed for an unauthenticated caller if that ever fails open.
  if (!(await isAuthenticated())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let live;
  try {
    live = getLiveSource();
    live.ensureStarted();
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "live source unavailable" },
      { status: 503 },
    );
  }
  const encoder = new TextEncoder();

  // Send an SSE comment every 20s so idle connections don't get closed by
  // proxies between the panel going quiet and the next snapshot. Comment
  // frames start with `:` and are silently discarded by EventSource.
  const HEARTBEAT_MS = 20_000;

  let cancel: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: () => void = () => {};

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      cancel = cleanup;

      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Controller closed underneath us; tear the rest down so we're not
          // holding the MQTT subscription and heartbeat interval for a dead
          // response.
          cleanup();
        }
      };
      const write = (event: string, data: unknown) => {
        enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const send = (snap: LiveSnapshot) => {
        write("flow", snap.flow);
        write("top", snap.top);
        write("circuits", snap.circuits);
      };

      // Prime with the latest snapshot, then stream updates.
      const initial = live.current();
      if (initial) send(initial);
      unsubscribe = live.subscribe(send);

      heartbeat = setInterval(() => {
        // Comment frames (`:`-prefixed) are silently discarded by EventSource
        // but keep intermediaries from closing an idle connection.
        enqueue(encoder.encode(`: keepalive\n\n`));
      }, HEARTBEAT_MS);

      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      // Fires when the platform tears down the response without dispatching
      // request.signal abort (e.g., some proxies).
      cancel();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
