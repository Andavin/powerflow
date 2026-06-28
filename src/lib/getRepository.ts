import { config } from "./config";
import { createQuestDbClient } from "./questdb";
import { QuestDbRepository, type Repository } from "./repository";
import { MockRepository } from "./mock";

let cached: Repository | null = null;

/** Process-wide repository, chosen by POWERFLOW_DATA_MODE. */
export function getRepository(): Repository {
  if (cached) return cached;
  const cfg = config();
  if (cfg.dataMode === "mock") {
    cached = new MockRepository();
  } else {
    const client = createQuestDbClient(cfg.questdbUrl);
    cached = new QuestDbRepository(client, {
      deviceId: cfg.deviceId,
      timezone: cfg.timezone,
    });
  }
  return cached;
}

/** Test helper. */
export function resetRepositoryCache(): void {
  cached = null;
}
