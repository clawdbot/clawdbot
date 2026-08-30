import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type {
  SessionAccessScope,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import { projectSqliteSessionParticipants } from "./session-accessor.sqlite-participant-projection.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";

type SessionStoreSummary = { count: number; recent: SessionEntrySummary[] };

/** Counts canonical owners and owns only their requested recent payloads, without warming the store cache. */
export function readSessionStoreSummaryReadOnly(
  scope: Pick<SessionAccessScope, "agentId" | "defaultAgentId" | "env" | "storePath">,
  options: {
    recentLimit: number;
    agentIds: readonly string[];
  },
): SessionStoreSummary & { byAgent: Map<string, SessionStoreSummary> } {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const summary: SessionStoreSummary & { byAgent: Map<string, SessionStoreSummary> } = {
    count: 0,
    recent: [],
    byAgent: new Map<string, SessionStoreSummary>(
      options.agentIds.map((agentId) => [agentId, { count: 0, recent: [] }]),
    ),
  };
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, () => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        const db = getSessionKysely(database.db);
        // The read transaction keeps count, ordering, and selected payloads on one
        // generation. Existing keys/indexes bound JSON work, not the cold canonical check.
        for (const row of iterateSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select(["session_key", "entry_valid"])
            .orderBy("updated_at", "desc")
            .orderBy("session_key", "asc"),
        )) {
          const owner = parseAgentSessionKey(row.session_key)?.agentId;
          if (!owner || isInternalSessionEffectsKey(row.session_key)) {
            continue;
          }
          const agent = summary.byAgent.get(owner);
          const needsRecent =
            summary.recent.length < options.recentLimit ||
            (agent !== undefined && agent.recent.length < options.recentLimit);
          if (row.entry_valid === 1 && !needsRecent) {
            summary.count += 1;
            if (agent) {
              agent.count += 1;
            }
            continue;
          }
          // Raw updates clear entry_valid. Preserve listing's warm-row semantics:
          // skip unreadable JSON/retained placeholders, but include readable pending rows.
          const stored = executeSqliteQueryTakeFirstSync(
            database.db,
            db.selectFrom("session_nodes").selectAll().where("session_key", "=", row.session_key),
          );
          if (!stored) {
            continue;
          }
          const { current_session_id: _currentSessionId, ...listRow } = stored;
          const parsed = parseSessionEntryJson(listRow);
          if (!parsed) {
            continue;
          }
          const entry = projectSqliteSessionParticipants(database.db, row.session_key, parsed);
          const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(
            row.session_key,
            entry,
          );
          if (deliveryCanonicalKey !== row.session_key) {
            throw canonicalSessionKeyMigrationRequiredError(
              `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
            );
          }
          summary.count += 1;
          const selected = { sessionKey: row.session_key, entry };
          if (summary.recent.length < options.recentLimit) {
            summary.recent.push(selected);
          }
          if (agent) {
            agent.count += 1;
            // The global newest rows may all belong to another agent. Select each
            // requested owner's window in this scan, sharing each parsed payload.
            if (agent.recent.length < options.recentLimit) {
              agent.recent.push(selected);
            }
          }
        }
        return summary;
      }),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : summary;
}
