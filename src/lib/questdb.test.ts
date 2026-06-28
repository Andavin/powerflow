import { describe, it, expect, vi } from "vitest";
import { createQuestDbClient, decodeRows, QuestDbError } from "./questdb";

describe("decodeRows", () => {
  it("zips columns and dataset tuples into objects", () => {
    const rows = decodeRows({
      columns: [
        { name: "ts", type: "TIMESTAMP" },
        { name: "pv", type: "DOUBLE" },
      ],
      dataset: [
        ["2026-06-28T00:00:00Z", -1234],
        ["2026-06-28T01:00:00Z", 0],
      ],
    });
    expect(rows).toEqual([
      { ts: "2026-06-28T00:00:00Z", pv: -1234 },
      { ts: "2026-06-28T01:00:00Z", pv: 0 },
    ]);
  });
});

describe("createQuestDbClient", () => {
  it("builds the /exec URL and decodes the response", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/exec?count=false&query=");
      expect(url).toContain(encodeURIComponent("SELECT 1"));
      return new Response(
        JSON.stringify({ columns: [{ name: "x", type: "INT" }], dataset: [[1]] }),
        { status: 200 },
      );
    });
    const client = createQuestDbClient("http://db:9000", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rows = await client.query("SELECT 1");
    expect(rows).toEqual([{ x: 1 }]);
  });

  it("throws QuestDbError on HTTP failure", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("bad column", { status: 400 }),
    );
    const client = createQuestDbClient("http://db:9000", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.query("SELECT bork")).rejects.toBeInstanceOf(QuestDbError);
  });

  it("surfaces a body-level error field", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "syntax", columns: [], dataset: [] }), {
          status: 200,
        }),
    );
    const client = createQuestDbClient("http://db:9000", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.query("SELECT")).rejects.toThrow(/syntax/);
  });
});
