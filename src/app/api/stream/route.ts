import type { NextRequest } from "next/server";
import { getLiveSource } from "@/lib/live/getLiveSource";
import type { LiveSnapshot } from "@/lib/live/types";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of live flow + top-consumer snapshots.
 *
 * Backed by a shared live source (MQTT when configured, else QuestDB polling),
 * so every connected client rides one upstream feed. Emits a `flow` event and a
 * `top` event per coalesced snapshot.
 */
export async function GET(request: NextRequest) {
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

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const send = (snap: LiveSnapshot) => {
        write("flow", snap.flow);
        write("top", snap.top);
        write("circuits", snap.circuits);
      };

      // Prime with the latest snapshot, then stream updates.
      const initial = live.current();
      if (initial) send(initial);
      const unsubscribe = live.subscribe(send);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", cleanup);
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
