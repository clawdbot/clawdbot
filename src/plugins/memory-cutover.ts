import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db.generated.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { ensureOpenClawAgentScopedMemorySchema } from "../state/openclaw-agent-scoped-memory-schema.js";

type MemoryCutoverDatabase = Pick<OpenClawAgentDatabaseSchema, "memory_migrations">;

// Migration/cutover is an operator lifecycle operation. The gateway reads one process-stable
// snapshot so a database failure cannot silently reopen legacy filesystem memory mid-run.
const cutoverByAgentId = new Map<string, boolean>();

/**
 * True only after Doctor has written a verified scoped-memory cutover marker. An unreadable
 * authority store fails closed: selected-memory callers must become unavailable, never legacy.
 */
export function isMemoryIsolationCutoverAgent(agentIdInput: string): boolean {
  const agentId = agentIdInput.trim();
  if (!agentId) {
    return true;
  }
  const cached = cutoverByAgentId.get(agentId);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const database = openOpenClawAgentDatabase({ agentId });
    ensureOpenClawAgentScopedMemorySchema(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getNodeSqliteKysely<MemoryCutoverDatabase>(database.db)
        .selectFrom("memory_migrations")
        .select("migration_id")
        .where("phase", "=", "cutover")
        .where("verified_at", "is not", null)
        .where("cutover_at", "is not", null)
        .limit(1),
    );
    const cutover = row !== undefined;
    cutoverByAgentId.set(agentId, cutover);
    return cutover;
  } catch {
    cutoverByAgentId.set(agentId, true);
    return true;
  }
}

export function resetMemoryIsolationCutoverForTest(): void {
  cutoverByAgentId.clear();
}
