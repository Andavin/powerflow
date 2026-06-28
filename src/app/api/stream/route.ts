import type { NextRequest } from "next/server";
import { getRepository } from "@/lib/getRepository";

export const dynamic = "force-dynamic";

const INTERVAL_MS = Number(process.env.POWERFLOW_STREAM_INTERVAL_MS ?? 2000);

/**
 * Server-Sent Events stream of live flow snapshots.
 *
 * QuestDB is poll-only, so we read the latest reading on an interval and push
 * it to the client. This drives the real-time flow animation; the client falls
 * back to plain polling if the stream drops.
 */
export async function GET(request: NextRequest) {
  const repo = getRepository();
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

      const tick = async () => {
        try {
          write("flow", await repo.getFlow());
        } catch (err) {
          write("stream-error", {
            message: err instanceof Error ? err.message : "unknown",
          });
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Prime immediately, then poll.
      void tick();
      const interval = setInterval(tick, INTERVAL_MS);
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
