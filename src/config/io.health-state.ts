import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { findStartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
// Stores config health fingerprints in shared SQLite state.
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OpenClawStateOwnershipError } from "../state/openclaw-state-ownership.js";
import { setBoundedConfigIoWarningEntry } from "./io.state.js";

// Fresh config snapshots share a database; retain failures until a write recovers.
const loggedHealthWriteFailures = new Map<string, string>();

export type ConfigHealthFingerprint = {
  hash: string;
  bytes: number;
  mtimeMs: number | null;
  ctimeMs: number | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
  hasMeta: boolean;
  gatewayMode: string | null;
  observedAt: string;
};

export type ConfigHealthEntry = {
  lastKnownGood?: ConfigHealthFingerprint;
  lastPromotedGood?: ConfigHealthFingerprint;
  lastObservedSuspiciousSignature?: string | null;
};

export type ConfigHealthState = {
  entries?: Record<string, ConfigHealthEntry>;
};

type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

type ConfigHealthStateDeps = {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  logger: Pick<typeof console, "warn">;
};

function resolveConfigHealthStateEnv(deps: ConfigHealthStateDeps): NodeJS.ProcessEnv {
  if (deps.env.OPENCLAW_HOME || deps.env.HOME || deps.env.USERPROFILE || deps.env.PREFIX) {
    return deps.env;
  }
  return { ...deps.env, HOME: deps.homedir() };
}

function parseConfigHealthFingerprint(value: string | null): ConfigHealthFingerprint | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as ConfigHealthFingerprint;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringifyConfigHealthFingerprint(
  value: ConfigHealthFingerprint | undefined,
): string | null {
  return value ? JSON.stringify(value) : null;
}

export function readConfigHealthStateFromStore(deps: ConfigHealthStateDeps): ConfigHealthState {
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(
        (database) => {
          const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(database.db);
          const rows = executeSqliteQuerySync(
            database.db,
            healthDb
              .selectFrom("config_health_entries")
              .select([
                "config_path",
                "last_known_good_json",
                "last_promoted_good_json",
                "last_observed_suspicious_signature",
              ])
              .orderBy("config_path", "asc"),
          ).rows;
          return {
            entries: Object.fromEntries(
              rows.map((row) => [
                row.config_path,
                {
                  lastKnownGood: parseConfigHealthFingerprint(row.last_known_good_json),
                  lastPromotedGood: parseConfigHealthFingerprint(row.last_promoted_good_json),
                  lastObservedSuspiciousSignature: row.last_observed_suspicious_signature,
                } satisfies ConfigHealthEntry,
              ]),
            ),
          };
        },
        { env: resolveConfigHealthStateEnv(deps) },
      ) ?? {}
    );
  } catch (error) {
    if (error instanceof OpenClawStateOwnershipError) {
      throw error;
    }
    return {};
  }
}

export function writeConfigHealthStateToStore(
  deps: ConfigHealthStateDeps,
  state: ConfigHealthState,
): void {
  const env = resolveConfigHealthStateEnv(deps);
  const databasePath = resolveOpenClawStateSqlitePath(env);
  try {
    const entries = Object.entries(state.entries ?? {});
    if (entries.length === 0) {
      return;
    }
    const updatedAtMs = Date.now();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
        executeSqliteQuerySync(
          db,
          healthDb
            .insertInto("config_health_entries")
            .values(
              entries.map(([configPath, entry]) => ({
                config_path: configPath,
                last_known_good_json: stringifyConfigHealthFingerprint(entry.lastKnownGood),
                last_promoted_good_json: stringifyConfigHealthFingerprint(entry.lastPromotedGood),
                last_observed_suspicious_signature: entry.lastObservedSuspiciousSignature ?? null,
                updated_at_ms: updatedAtMs,
              })),
            )
            .onConflict((conflict) =>
              conflict.column("config_path").doUpdateSet({
                last_known_good_json: (eb) => eb.ref("excluded.last_known_good_json"),
                last_promoted_good_json: (eb) => eb.ref("excluded.last_promoted_good_json"),
                last_observed_suspicious_signature: (eb) =>
                  eb.ref("excluded.last_observed_suspicious_signature"),
                updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
              }),
            ),
        );
      },
      { env, path: databasePath },
    );
    loggedHealthWriteFailures.delete(databasePath);
  } catch (error) {
    if (
      error instanceof OpenClawStateOwnershipError ||
      findStartupMaintenanceRequiredError(error)
    ) {
      throw error;
    }
    const message = formatErrorMessage(error);
    const repeated = loggedHealthWriteFailures.get(databasePath) === message;
    setBoundedConfigIoWarningEntry(loggedHealthWriteFailures, databasePath, message);
    if (!repeated) {
      deps.logger.warn(`Config health-state write failed: ${message}`);
    }
  }
}
