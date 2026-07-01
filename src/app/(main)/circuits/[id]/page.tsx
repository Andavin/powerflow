import { CircuitDetail } from "@/components/screens/CircuitDetail";
import { config } from "@/lib/config";

export default async function CircuitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CircuitDetail id={id} controlEnabled={config().controlEnabled} />;
}
