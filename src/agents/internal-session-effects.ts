import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
/** Manages hidden SQLite sessions used for suppressed agent side effects. */
import {
  applySessionEntryLifecycleMutation,
  forkSessionFromParentTranscript,
  loadExactSessionEntry,
  replaceTranscriptEvents,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";

type InternalSessionEffectsTarget = Required<
  Pick<AgentRunSessionTarget, "agentId" | "sessionId" | "sessionKey" | "storePath">
> & {
  sessionEntry: SessionEntry;
  sessionFile: string;
};

type InternalSessionEffectsSource = Required<
  Pick<AgentRunSessionTarget, "agentId" | "sessionId" | "sessionKey" | "storePath">
>;

/** Resolves the deterministic SQLite target owned by one internal-effects run. */
export function resolveInternalSessionEffectsTarget(params: {
  agentId: string;
  runId: string;
  storePath: string;
}): Required<Pick<AgentRunSessionTarget, "agentId" | "sessionId" | "sessionKey" | "storePath">> {
  const incognito = isIncognitoOpenClawAgentSqlitePath(params.storePath, {
    agentId: params.agentId,
  });
  return {
    agentId: params.agentId,
    storePath: params.storePath,
    ...resolveInternalSessionEffectsIdentity({
      agentId: params.agentId,
      runId: params.runId,
      ...(incognito ? { incognito: true } : {}),
    }),
  };
}

function toInternalSessionEffectsTarget(params: {
  agentId: string;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): InternalSessionEffectsTarget {
  return {
    agentId: params.agentId,
    sessionId: params.entry.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    sessionEntry: params.entry,
    sessionFile: formatSqliteSessionFileMarker({
      agentId: params.agentId,
      sessionId: params.entry.sessionId,
      storePath: params.storePath,
    }),
  };
}

/** Creates or reopens the hidden SQLite session owned by one internal-effects run. */
export async function prepareInternalSessionEffectsSession(params: {
  agentId: string;
  cwd?: string;
  runId: string;
  source?: InternalSessionEffectsSource;
  storePath: string;
}): Promise<InternalSessionEffectsTarget> {
  const scope = resolveInternalSessionEffectsTarget(params);
  const existing = loadExactSessionEntry(scope)?.entry;
  if (existing?.sessionId === scope.sessionId) {
    return toInternalSessionEffectsTarget({
      agentId: params.agentId,
      entry: existing,
      sessionKey: scope.sessionKey,
      storePath: params.storePath,
    });
  }

  const fork = params.source
    ? await forkSessionFromParentTranscript({
        agentId: params.source.agentId,
        parentEntry: { sessionId: params.source.sessionId, updatedAt: Date.now() },
        parentSessionKey: params.source.sessionKey,
        sessionKey: scope.sessionKey,
        storePath: params.source.storePath,
        targetSessionId: scope.sessionId,
        targetStorePath: params.storePath,
      })
    : undefined;
  if (fork?.status !== "created") {
    await replaceTranscriptEvents(scope, [
      createSessionTranscriptHeader({ cwd: params.cwd, sessionId: scope.sessionId }),
    ]);
  }
  const now = Date.now();
  const entry = await upsertSessionEntry(scope, {
    ...buildSessionCreationStamp({ via: "internal", actor: { type: "system" } }),
    delivery: { kind: "internal" },
    sessionId: scope.sessionId,
    ...(isIncognitoOpenClawAgentSqlitePath(params.storePath, { agentId: params.agentId })
      ? { incognito: true as const }
      : {}),
    sessionStartedAt: now,
    updatedAt: now,
  });
  if (!entry) {
    throw new Error(`Failed to create internal SQLite session for run ${params.runId}`);
  }
  return toInternalSessionEffectsTarget({
    agentId: params.agentId,
    entry,
    sessionKey: scope.sessionKey,
    storePath: params.storePath,
  });
}

/** Hard-deletes a run-owned hidden session and its SQLite transcript rows. */
export async function removeInternalSessionEffectsSession(
  target: AgentRunSessionTarget | undefined,
): Promise<void> {
  if (!target?.sessionKey || !target.storePath) {
    return;
  }
  await applySessionEntryLifecycleMutation({
    ...(target.agentId ? { agentId: target.agentId } : {}),
    storePath: target.storePath,
    removals: [
      {
        sessionKey: target.sessionKey,
        ...(target.sessionId ? { expectedSessionId: target.sessionId } : {}),
        archiveRemovedTranscript: false,
      },
    ],
    skipMaintenance: true,
  });
}
