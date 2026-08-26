import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  confirmSessionParticipantsSchemaEnsured,
  ensureSessionParticipantsSchema,
} from "../../state/openclaw-agent-session-participants-schema.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  MAX_SESSION_PARTICIPANTS,
  mergeSessionParticipantSource,
  type SessionCreatedActor,
  type SessionParticipantSource,
} from "./session-entry-provenance.js";

export { MAX_SESSION_PARTICIPANTS };

export type RecordSessionParticipantResult = "inserted" | "updated" | "capped";

export function recordSessionParticipant(
  scope: SessionAccessScope,
  params: {
    actor: SessionCreatedActor & { id: string };
    promptedAt?: number;
    sessionAgentId?: string;
    source: SessionParticipantSource;
  },
): RecordSessionParticipantResult | null {
  const actorId = params.actor.id.trim();
  if (
    (params.actor.type !== "agent" && params.actor.type !== "human") ||
    !actorId ||
    (params.actor.type === "agent" && actorId === params.sessionAgentId)
  ) {
    return null;
  }
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const promptedAt = params.promptedAt ?? Date.now();
  const result = runOpenClawAgentWriteTransaction(
    (database) => {
      if (ensureSessionParticipantsSchema(database.db)) {
        deferOpenClawAgentPostCommitPublication(database, () =>
          confirmSessionParticipantsSchemaEnsured(database.db),
        );
      }
      const kysely = getSessionKysely(database.db);
      const existing = executeSqliteQueryTakeFirstSync(
        database.db,
        kysely
          .selectFrom("session_participants")
          .select([
            "actor_id",
            "actor_source",
            "contribution_count",
            "first_prompted_at",
            "last_prompted_at",
          ])
          .where("session_key", "=", resolved.sessionKey)
          .where("actor_type", "=", params.actor.type)
          .where("actor_id", "=", actorId),
      );
      if (!existing) {
        const count = executeSqliteQueryTakeFirstSync(
          database.db,
          kysely
            .selectFrom("session_participants")
            .select((builder) => builder.fn.countAll<number>().as("count"))
            .where("session_key", "=", resolved.sessionKey),
        )?.count;
        if ((count ?? 0) >= MAX_SESSION_PARTICIPANTS) {
          return "capped";
        }
      }
      const profileContribution = params.actor.type === "human" && params.source === "profile";
      const existingProfile = existing?.actor_source === "profile";
      executeSqliteQuerySync(
        database.db,
        kysely
          .insertInto("session_participants")
          .values({
            session_key: resolved.sessionKey,
            actor_type: params.actor.type,
            actor_id: actorId,
            actor_source: params.source,
            contribution_count: profileContribution ? 1 : null,
            first_prompted_at: promptedAt,
            last_prompted_at: promptedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["session_key", "actor_type", "actor_id"]).doUpdateSet({
              actor_source: mergeSessionParticipantSource(existing?.actor_source, params.source),
              contribution_count: profileContribution
                ? existingProfile
                  ? (existing.contribution_count ?? 1) + 1
                  : 1
                : (existing?.contribution_count ?? null),
              first_prompted_at:
                profileContribution && !existingProfile
                  ? promptedAt
                  : existingProfile && !profileContribution
                    ? existing.first_prompted_at
                    : Math.min(existing?.first_prompted_at ?? promptedAt, promptedAt),
              last_prompted_at: Math.max(existing?.last_prompted_at ?? promptedAt, promptedAt),
            }),
          ),
      );
      publishSessionEntryCacheInvalidation(database);
      return existing ? "updated" : "inserted";
    },
    options,
    { operationLabel: "sessions.record-participant" },
  );
  return result;
}
