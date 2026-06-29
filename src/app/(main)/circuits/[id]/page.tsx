import { CircuitDetail } from "@/components/screens/CircuitDetail";

export default async function CircuitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CircuitDetail id={id} />;
}
