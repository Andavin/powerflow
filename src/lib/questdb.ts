/** A QuestDB row decoded into a column-keyed object. */
export type Row = Record<string, unknown>;

/**
 * Minimal QuestDB HTTP client.
 *
 * Talks to the `/exec` endpoint and decodes the columnar JSON response into
 * column-keyed row objects. No third-party driver — the surface we need is tiny
 * and this keeps the dependency footprint (and attack surface) small.
 */

export interface QuestDbResponse {
  columns: Array<{ name: string; type: string }>;
  dataset: unknown[][];
}

export class QuestDbError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly query?: string,
  ) {
    super(message);
    this.name = "QuestDbError";
  }
}

export interface QuestDbClient {
  query(sql: string): Promise<Row[]>;
}

export function createQuestDbClient(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): QuestDbClient {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const doFetch = opts.fetchImpl ?? fetch;

  async function queryRaw(sql: string): Promise<QuestDbResponse> {
    const url = `${baseUrl}/exec?count=false&query=${encodeURIComponent(sql)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch {
          /* ignore */
        }
        throw new QuestDbError(
          `QuestDB ${res.status}: ${detail.slice(0, 300)}`,
          res.status,
          sql,
        );
      }
      const body = (await res.json()) as QuestDbResponse & { error?: string };
      if (body.error) throw new QuestDbError(body.error, res.status, sql);
      return body;
    } catch (err) {
      if (err instanceof QuestDbError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new QuestDbError(`QuestDB query timed out after ${timeoutMs}ms`, undefined, sql);
      }
      throw new QuestDbError(
        `QuestDB request failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        sql,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function query(sql: string): Promise<Row[]> {
    const body = await queryRaw(sql);
    return decodeRows(body);
  }

  return { query };
}

/** Decode QuestDB's columnar `{columns, dataset}` into row objects. */
export function decodeRows(body: QuestDbResponse): Row[] {
  const names = body.columns.map((c) => c.name);
  return body.dataset.map((tuple) => {
    const row: Row = {};
    for (let i = 0; i < names.length; i++) row[names[i]] = tuple[i];
    return row;
  });
}
