import { StatsScreen } from "@/components/screens/StatsScreen";
import { STAT_SOURCES, type StatSource } from "@/lib/types";

// Deep-link support: /stats?source=solar preselects that source (the period
// stays on its default, "today"). The Overview tiles link here.
//
// In the App Router (Next 15+/16), `searchParams` is async — a Promise — so the
// page is async and awaits it (see node_modules/next/dist/docs and the
// params/Promise usage in circuits/[id]/page.tsx).
export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>;
}) {
  const { source } = await searchParams;
  const s = Array.isArray(source) ? source[0] : source;
  const initialSource = STAT_SOURCES.includes(s as StatSource) ? (s as StatSource) : undefined;
  return <StatsScreen initialSource={initialSource} />;
}
