import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateSchema } from "./openclaw-state-db-existing-write.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "./openclaw-state-db-readonly.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const replayWriterSchema = ["schema_meta", "state_leases", "agent_database_leases"]
  .map((table) => {
    const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(") STRICT;", start);
    if (start < 0 || end < 0) {
      throw new Error("Replay writer schema is unavailable");
    }
    return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + ") STRICT;".length);
  })
  .join("\n");

/** Read-only drainage evidence, never a new lease or physical/executor authority.
 * The caller holds Gateway, source and physical state exclusion, which prevents
 * new registrations. Do not delete stale rows or renew a sealed family's leases. */
export function assertOpenClawStateReplayWritersStopped(
  options: OpenClawStateDatabaseOptions,
  assertCurrent: () => void,
): void {
  assertCurrent();
  const inspected = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db, path }) => {
    assertCurrent();
    assertExistingOpenClawStateSchema(db, path, replayWriterSchema);
    const query = getNodeSqliteKysely<Pick<DB, "state_leases" | "agent_database_leases">>(db);
    const leases = executeSqliteQuerySync(
      db,
      query.selectFrom("state_leases").select(["scope", "lease_key", "expires_at"]),
    ).rows;
    if (
      leases.some(
        (lease) =>
          ["core:plugin-lifecycle", "core:agent-database-maintenance"].includes(lease.scope) &&
          lease.lease_key === "global" &&
          (lease.expires_at === null || lease.expires_at > Date.now()),
      )
    ) {
      throw new Error(
        "An existing plugin or agent maintenance lease still prevents publication recovery",
      );
    }
    const agents = executeSqliteQuerySync(
      db,
      query.selectFrom("agent_database_leases").select(["owner_pid", "owner_start_time"]),
    ).rows;
    for (const agent of agents) {
      const start = getFileLockProcessStartTime(agent.owner_pid, options.env);
      if (
        !isPidDefinitelyDead(agent.owner_pid) &&
        !(agent.owner_start_time !== null && start !== null && agent.owner_start_time !== start)
      ) {
        throw new Error(
          "A live or unidentifiable agent database writer prevents publication recovery",
        );
      }
      assertCurrent();
    }
    return true;
  }, options);
  assertCurrent();
  if (!inspected) {
    throw new Error("Replay writer evidence is missing; canonical absence is not drainage");
  }
}
