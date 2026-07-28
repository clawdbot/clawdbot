// Stores voice wake trigger configuration.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

// Voice wake config stores trigger words used by local voice integrations.
type VoiceWakeConfig = {
  triggers: string[];
  updatedAtMs: number;
};

const DEFAULT_TRIGGERS = ["openclaw", "claude", "computer"];
const VOICEWAKE_CONFIG_KEY = "default";

type VoiceWakeDatabase = Pick<OpenClawStateKyselyDatabase, "voicewake_triggers">;

function sanitizeTriggers(triggers: string[] | undefined | null): string[] {
  const cleaned = (triggers ?? [])
    .map((w) => normalizeOptionalString(w) ?? "")
    .filter((w) => w.length > 0);
  return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}

function openStateDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
}

/** Return the built-in voice wake trigger list. */
export function defaultVoiceWakeTriggers() {
  return [...DEFAULT_TRIGGERS];
}

/** Load persisted voice wake triggers, falling back to defaults. */
export async function loadVoiceWakeConfig(baseDir?: string): Promise<VoiceWakeConfig> {
  const database = openStateDatabase(baseDir);
  const voicewakeDb = getNodeSqliteKysely<VoiceWakeDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    voicewakeDb
      .selectFrom("voicewake_triggers")
      .select(["trigger", "updated_at_ms"])
      .where("config_key", "=", VOICEWAKE_CONFIG_KEY)
      .orderBy("position", "asc"),
  ).rows;
  if (rows.length === 0) {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
  return {
    triggers: sanitizeTriggers(rows.map((row) => row.trigger)),
    updatedAtMs: Math.max(0, ...rows.map((row) => row.updated_at_ms)),
  };
}

/** Persist the configured voice wake trigger list. */
export async function setVoiceWakeTriggers(
  triggers: string[],
  baseDir?: string,
): Promise<VoiceWakeConfig> {
  const sanitized = sanitizeTriggers(triggers);
  const updatedAtMs = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const voicewakeDb = getNodeSqliteKysely<VoiceWakeDatabase>(db);
      executeSqliteQuerySync(
        db,
        voicewakeDb.deleteFrom("voicewake_triggers").where("config_key", "=", VOICEWAKE_CONFIG_KEY),
      );
      executeSqliteQuerySync(
        db,
        voicewakeDb.insertInto("voicewake_triggers").values(
          sanitized.map((trigger, position) => ({
            config_key: VOICEWAKE_CONFIG_KEY,
            position,
            trigger,
            updated_at_ms: updatedAtMs,
          })),
        ),
      );
    },
    baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {},
  );
  return {
    triggers: sanitized,
    updatedAtMs,
  };
}
