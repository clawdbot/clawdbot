import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  confirmSessionParticipantsSchemaEnsured,
  ensureSessionParticipantsSchema,
} from "../../state/openclaw-agent-session-participants-schema.js";
import { readUserProfileAliases } from "../../state/user-profiles.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { MAX_SESSION_PARTICIPANTS } from "./session-entry-provenance.js";
import {
  participantIdentityNamespace,
  mergeParticipantAggregate,
  type SessionParticipantIdentity,
} from "./session-participant-identity.js";

export { MAX_SESSION_PARTICIPANTS };

export type RecordSessionParticipantResult = "inserted" | "updated" | "capped";

export function recordSessionParticipant(
  scope: SessionAccessScope,
  params: {
    identity: SessionParticipantIdentity;
    promptedAt?: number;
    sessionAgentId?: string;
  },
): RecordSessionParticipantResult | null {
  const actorId = params.identity.id;
  if (!actorId || (params.identity.type === "agent" && actorId === params.sessionAgentId)) {
    return null;
  }
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const promptedAt = params.promptedAt ?? Date.now();
  const namespace = participantIdentityNamespace(params.identity);
  const aliases =
    params.identity.type === "profile"
      ? readUserProfileAliases(actorId, { env: scope.env })
      : undefined;
  const result = runOpenClawAgentWriteTransaction(
    (database) => {
      if (ensureSessionParticipantsSchema(database.db)) {
        deferOpenClawAgentPostCommitPublication(database, () =>
          confirmSessionParticipantsSchemaEnsured(database.db),
        );
      }
      const kysely = getSessionKysely(database.db);
      const records = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("session_participants")
          .selectAll()
          .where("session_key", "=", resolved.sessionKey)
          .orderBy("actor_id"),
      ).rows;
      // Prefer the exact row, otherwise the first retained alias. Preserve raw history;
      // read-time canonicalization combines aliases without a cross-database rewrite.
      const existing =
        records.find((row) => row.identity_namespace === namespace && row.actor_id === actorId) ??
        records.find((row) => row.identity_namespace === namespace && aliases?.has(row.actor_id));
      if (!existing && records.length >= MAX_SESSION_PARTICIPANTS) {
        return "capped";
      }
      const aggregate = mergeParticipantAggregate(
        existing,
        {
          contribution_count: 1,
          first_prompted_at: promptedAt,
          last_prompted_at: promptedAt,
        },
        "sum",
      );
      executeSqliteQuerySync(
        database.db,
        kysely
          .insertInto("session_participants")
          .values({
            session_key: resolved.sessionKey,
            identity_namespace: namespace,
            actor_id: existing?.actor_id ?? actorId,
            ...aggregate,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["session_key", "identity_namespace", "actor_id"])
              .doUpdateSet(aggregate),
          ),
      );
      publishSessionEntryCacheInvalidation(database);
      deferOpenClawAgentPostCommitPublication(database, () =>
        emitSessionLifecycleEvent({
          agentId: resolved.agentId,
          sessionKey: resolved.sessionKey,
          reason: "participants",
        }),
      );
      return existing ? "updated" : "inserted";
    },
    options,
    { operationLabel: "sessions.record-participant" },
  );
  return result;
}
