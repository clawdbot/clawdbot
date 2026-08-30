/** Durable malformed-cron recovery records stored in the shared SQLite database. */
import { createHash } from "node:crypto";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createSqliteAuditRecordStore } from "../../infra/sqlite-audit-record-store.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { cronStoreKey } from "./key.js";
import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "./types.js";

type CronQuarantineDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;

function cronQuarantineScope(storePath: string): string {
  return `cron.quarantine:${cronStoreKey(storePath)}`;
}

function cronQuarantineEntryKey(entry: QuarantinedCronConfigJob): string {
  const identity = JSON.stringify({
    sourceIndex: entry.sourceIndex,
    reason: entry.reason,
    job: entry.job ?? null,
    raw: entry.raw ?? null,
    state: entry.state ?? null,
    updatedAtMs: entry.updatedAtMs ?? null,
    scheduleIdentity: entry.scheduleIdentity ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

/** Reads quarantined cron rows without creating or migrating a state database. */
export function loadCronQuarantinedJobs(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): CronQuarantinedJob[] {
  const scope = cronQuarantineScope(storePath);
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<CronQuarantineDatabase>(db)
            .selectFrom("diagnostic_events")
            .select("payload_json")
            .where("scope", "=", scope)
            .orderBy("sequence", "asc"),
        ).rows.map((row) => JSON.parse(row.payload_json) as CronQuarantinedJob),
      { env },
    ) ?? []
  );
}

/** Writes recovery records into the caller-owned SQLite transaction when provided. */
export function saveCronQuarantinedJobs(params: {
  storePath: string;
  entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
  nowMs: number;
  database?: OpenClawStateDatabase;
}): void {
  if (params.entries.length === 0) {
    return;
  }

  // Quarantine contains recoverable operator jobs, not disposable audit history.
  const store = createSqliteAuditRecordStore<CronQuarantinedJob>({
    scope: cronQuarantineScope(params.storePath),
    maxEntries: Number.MAX_SAFE_INTEGER,
    ...(params.database ? { database: params.database } : {}),
  });

  const records = params.entries.map((entry) => {
    const quarantinedAtMs = "quarantinedAtMs" in entry ? entry.quarantinedAtMs : params.nowMs;
    return {
      key: cronQuarantineEntryKey(entry),
      value: { ...entry, quarantinedAtMs },
      createdAt: quarantinedAtMs,
    };
  });

  store.registerLegacyMany(records);
}
