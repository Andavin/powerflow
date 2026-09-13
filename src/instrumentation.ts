/**
 * Runs once when the Next.js server starts (Node runtime only — the same file
 * is evaluated for the edge runtime, where there's nothing to do).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startNotifyWatcher } = await import("./lib/notify/service");
  startNotifyWatcher();
}
