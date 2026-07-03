"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Segmented, Spinner, StatNumber, StatusPill, ErrorNote } from "@/components/primitives";
import { useCircuitEnergy, useLiveStream } from "@/lib/client/data";
import { splitPower, splitEnergy } from "@/lib/format";
import type { Circuit } from "@/lib/types";

type SortMode = "activity" | "panel" | "name";

const SORTS = [
  { value: "activity" as const, label: "By Activity" },
  { value: "panel" as const, label: "In Panel" },
  { value: "name" as const, label: "A–Z" },
];

function sortCircuits(circuits: Circuit[], mode: SortMode): Circuit[] {
  const copy = [...circuits];
  switch (mode) {
    case "activity":
      return copy.sort((a, b) => b.watts - a.watts);
    case "panel":
      return copy.sort((a, b) => (a.space ?? 99) - (b.space ?? 99));
    case "name":
      return copy.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function CircuitsScreen() {
  const { circuits: liveCircuits, connected, error } = useLiveStream();
  const { data: energyData } = useCircuitEnergy("today");
  const energyById = useMemo(
    () => new Map((energyData?.circuits ?? []).map((c) => [c.id, c.kWh])),
    [energyData],
  );
  const [sort, setSort] = useState<SortMode>("activity");
  const [search, setSearch] = useState("");

  const circuits = useMemo(() => {
    const filtered = search
      ? liveCircuits.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
      : liveCircuits;
    return sortCircuits(filtered, sort);
  }, [liveCircuits, sort, search]);

  const loading = liveCircuits.length === 0 && !connected;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-3xl font-bold tracking-tight">Circuits</h1>

      <Segmented options={SORTS} value={sort} onChange={setSort} size="sm" ariaLabel="Sort circuits" />

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search for circuits"
        aria-label="Search circuits"
        className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-fg outline-none placeholder:text-faint focus:border-battery focus-visible:border-battery focus-visible:ring-2 focus-visible:ring-battery/40"
      />

      {error && <ErrorNote message={String(error)} />}
      {loading && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      <ul className="flex flex-col gap-2" aria-label="Circuit list">
        {circuits.map((c) => {
          const p = splitPower(c.watts);
          const today = energyById.get(c.id);
          const e = today != null ? splitEnergy(today) : null;
          return (
            <li key={c.id}>
              <Link
                href={`/circuits/${encodeURIComponent(c.id)}`}
                className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-4 transition hover:border-battery/60 hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  {e && <span className="text-xs text-faint">{e.value} {e.unit} today</span>}
                </span>
                <StatusPill on={c.isOn} />
                <span className="w-20 text-right">
                  <StatNumber value={p.value} unit={p.unit} />
                </span>
                <span className="text-faint">›</span>
              </Link>
            </li>
          );
        })}
        {!loading && circuits.length === 0 && (
          <li className="py-10 text-center text-sm text-faint">No circuits match.</li>
        )}
      </ul>
    </div>
  );
}
