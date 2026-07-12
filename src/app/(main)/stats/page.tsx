import { StatsScreen } from "@/components/screens/StatsScreen";
import type { StatSource } from "@/lib/types";

const SOURCES: StatSource[] = ["home", "solar", "battery", "grid"];

// Deep-link support: /stats?source=solar preselects that source (the period
// stays on its default, "today"). The Overview tiles link here.
export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>;
}) {
  const { source } = await searchParams;
  const s = Array.isArray(source) ? source[0] : source;
  const initialSource = SOURCES.includes(s as StatSource) ? (s as StatSource) : undefined;
  return <StatsScreen initialSource={initialSource} />;
}
