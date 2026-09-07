import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseSemver } from "semver";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  preflightOpenClawDatabaseSchemas,
  type OpenClawDatabaseSchemaPreflight,
} from "../state/openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";

// 2026.9.2 introduced the ledger without fencing post-Doctor access. Earlier
// updaters never reopen state; #138839 fenced every 2026.9.3-and-later build.
// Compare the parsed release line so 2026.9.2 rebuilds are included and
// 2026.9.3 prereleases are excluded, independently of this checkout's VERSION.
const UNFENCED_LEDGER_UPDATER_RELEASE = "2026.9.2";

/** A pre-transaction updater would reopen the migrated ledger with its old code. */
class DoctorUpdateSchemaRefusalError extends Error {
  readonly code = "update-schema-bump-unfenced";
  readonly targetVersion = VERSION;
  readonly commands: string[];

  constructor(
    readonly databases: NonNullable<OpenClawDatabaseSchemaPreflight["pendingMigrations"]>,
    readonly updaterVersion: string,
  ) {
    const commands = [
      "openclaw gateway stop",
      `npm install -g openclaw@${VERSION} --allow-scripts=openclaw`,
      "openclaw doctor --fix",
      "openclaw gateway start",
    ];
    super(
      `Doctor refused update-time schema repair driven by OpenClaw ${updaterVersion}: this updater reopens the ledger with old code after migration. ` +
        databases
          .map(
            (database) =>
              `${database.kind} database ${database.path}: on-disk schema ${database.foundVersion}, this build's schema ${database.supportedVersion}.`,
          )
          .join(" ") +
        " No doctor repairs were applied. Let the updater restore the previous package, then update manually: " +
        `${commands.join(" && ")}. ` +
        `Use the package manager that owns this install (pnpm: pnpm add -g --allow-build=openclaw openclaw@${VERSION}; Bun: bun add -g --trust openclaw@${VERSION}). On npm 11.15 and earlier, omit --allow-scripts=openclaw.`,
    );
    this.name = "DoctorUpdateSchemaRefusalError";
    this.commands = commands;
  }
}

async function readDrivingUpdaterVersion(): Promise<string | undefined> {
  // The runtime ledger reader consults quarantine state. This diagnostic must
  // not open any live database, including a quarantine store needing recovery.
  const snapshot = await prepareSqliteReadOnlyLocation(resolveOpenClawStateSqlitePath(), {
    preserveSourceArtifacts: true,
  });
  try {
    const database = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    try {
      if (!tableExists(database, "update_runs")) {
        return undefined;
      }
      const row = executeSqliteQueryTakeFirstSync(
        database,
        getNodeSqliteKysely<Pick<DB, "update_runs">>(database)
          .selectFrom("update_runs")
          .select("before_json")
          .where("status", "=", "running")
          .orderBy("created_at_ms", "desc")
          .orderBy("run_id", "desc")
          .limit(1),
      );
      const before: unknown = row ? JSON.parse(row.before_json) : undefined;
      return isRecord(before) && typeof before.version === "string" ? before.version : undefined;
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(database);
      database.close();
    }
  } finally {
    snapshot.cleanup();
  }
}

/** Refuse before CLI capture or Doctor maintenance can open writable state. */
export async function guardUpdateDoctorSchemaUpgrade(options: {
  schemas?: OpenClawDatabaseSchemaPreflight;
  runtime: RuntimeEnv;
  json?: boolean;
}): Promise<void> {
  if (process.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1") {
    return;
  }
  const schemas =
    options.schemas ??
    (await preflightOpenClawDatabaseSchemas({
      env: process.env,
      supportedVersions: {
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
    }));
  if (!schemas.pendingMigrations?.length) {
    return;
  }
  let updaterVersion: string | undefined;
  try {
    updaterVersion = await readDrivingUpdaterVersion();
  } catch {
    // A missing or unreadable run cannot prove that the driver writes the ledger.
  }
  if (!updaterVersion) {
    return;
  }
  const driver = parseSemver(updaterVersion);
  if (
    !driver ||
    `${driver.major}.${driver.minor}.${driver.patch}` !== UNFENCED_LEDGER_UPDATER_RELEASE
  ) {
    return;
  }
  const error = new DoctorUpdateSchemaRefusalError(schemas.pendingMigrations, updaterVersion);
  if (options.json) {
    writeRuntimeJson(options.runtime, {
      ok: false,
      error: {
        type: "cli_error",
        code: error.code,
        message: error.message,
        databases: error.databases,
        updaterVersion: error.updaterVersion,
        targetVersion: error.targetVersion,
        commands: error.commands,
      },
    });
    exitCliAfterOutput(options.runtime, 1);
  }
  throw error;
}
