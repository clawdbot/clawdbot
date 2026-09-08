import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type {
  ProjectedLifecycleMutation,
  SessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SessionEntry } from "./types.js";

type SessionIdentityDatabase = OpenClawAgentDatabaseClaim["database"];

function toSessionIdentityTarget(entry: SessionEntry | undefined, sessionKeys: readonly string[]) {
  const sessionId = normalizeOptionalString(entry?.sessionId);
  return { ...(sessionId ? { sessionId } : {}), sessionKeys };
}

export function prepareCommittedSessionEntryRemovals(
  agentId: string,
  removals: readonly SessionEntryRemovalPlan[],
): () => void {
  const previousByKey = new Map<string, ReturnType<typeof toSessionIdentityTarget>>();
  for (const removal of removals) {
    if (!previousByKey.has(removal.sessionKey)) {
      previousByKey.set(
        removal.sessionKey,
        toSessionIdentityTarget(removal.expectedEntry, [removal.sessionKey]),
      );
    }
  }
  return () => {
    for (const previous of previousByKey.values()) {
      emitSessionIdentityMutation({ agentId, kind: "delete", previous });
    }
  };
}

export function prepareSessionIdentityPublication(
  database: SessionIdentityDatabase,
  agentId: string,
  previous: ReadonlyMap<string, SessionEntry>,
  current: ReadonlyMap<string, SessionEntry>,
): () => void {
  const publish = () => {
    const currentKeysBySessionId = new Map<string, string[]>();
    for (const [sessionKey, entry] of current) {
      const sessionId = normalizeOptionalString(entry.sessionId);
      if (sessionId) {
        currentKeysBySessionId.set(sessionId, [
          ...(currentKeysBySessionId.get(sessionId) ?? []),
          sessionKey,
        ]);
      }
    }

    const movedKeysByCurrentKey = new Map<string, string[]>();
    const handledPreviousKeys = new Set<string>();
    for (const [sessionKey, entry] of previous) {
      if (current.has(sessionKey)) {
        continue;
      }
      const sessionId = normalizeOptionalString(entry.sessionId);
      const currentKeys = sessionId ? currentKeysBySessionId.get(sessionId) : undefined;
      if (currentKeys?.length !== 1) {
        continue;
      }
      const [currentKey] = currentKeys;
      if (!currentKey) {
        continue;
      }
      movedKeysByCurrentKey.set(currentKey, [
        ...(movedKeysByCurrentKey.get(currentKey) ?? []),
        sessionKey,
      ]);
      handledPreviousKeys.add(sessionKey);
    }
    for (const [currentKey, previousKeys] of movedKeysByCurrentKey) {
      const currentEntry = current.get(currentKey);
      if (currentEntry) {
        emitSessionIdentityMutation({
          agentId,
          kind: "move",
          previous: toSessionIdentityTarget(currentEntry, previousKeys),
          current: toSessionIdentityTarget(currentEntry, [currentKey]),
        });
      }
    }

    for (const [sessionKey, previousEntry] of previous) {
      const currentEntry = current.get(sessionKey);
      const previousTarget = toSessionIdentityTarget(previousEntry, [sessionKey]);
      if (currentEntry) {
        const currentTarget = toSessionIdentityTarget(currentEntry, [sessionKey]);
        if (previousTarget.sessionId !== currentTarget.sessionId) {
          emitSessionIdentityMutation({
            agentId,
            kind: "replace",
            previous: previousTarget,
            current: currentTarget,
          });
        }
      } else if (!handledPreviousKeys.has(sessionKey)) {
        emitSessionIdentityMutation({ agentId, kind: "delete", previous: previousTarget });
      }
    }

    for (const [sessionKey, currentEntry] of current) {
      if (previous.has(sessionKey) || movedKeysByCurrentKey.has(sessionKey)) {
        continue;
      }
      emitSessionIdentityMutation({
        agentId,
        kind: "create",
        previous: { sessionKeys: [] },
        current: toSessionIdentityTarget(currentEntry, [sessionKey]),
      });
    }
  };
  // Savepoint success is not COMMIT; identity observers can cancel live work.
  return () => {
    if (!deferSqlitePostCommitPublication(database.db, publish)) {
      publish();
    }
  };
}

export function prepareLifecycleIdentityPublication(params: {
  database: SessionIdentityDatabase;
  agentId: string;
  projected: ProjectedLifecycleMutation;
  removedSessionKeys: readonly string[];
}): () => void {
  const removedKeys = new Set(params.removedSessionKeys);
  const previous = new Map(
    params.projected.removals
      .filter((removal) => removedKeys.has(removal.sessionKey))
      .map((removal) => [removal.sessionKey, removal.expectedEntry]),
  );
  const current = new Map<string, SessionEntry>();
  for (const upsert of params.projected.upsertedEntries) {
    if (!current.has(upsert.sessionKey) && upsert.expectedEntry) {
      previous.set(upsert.sessionKey, upsert.expectedEntry);
    }
    current.set(upsert.sessionKey, upsert.entry);
  }
  return prepareSessionIdentityPublication(params.database, params.agentId, previous, current);
}
