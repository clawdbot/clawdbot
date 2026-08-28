import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
/** Manages hidden SQLite sessions used for suppressed agent side effects. */
import {
  applySessionEntryLifecycleMutation,
  forkSessionFromParentTranscript,
  loadExactSessionEntry,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";

const log = createSubsystemLogger("agents/agent-command");

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
    sessionFile: params.sessionKey,
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
  const entry = await upsertSessionEntryCore(scope, {
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

/**
 * Best-effort cleanup of every run-owned hidden session after delivery. A
 * terminal SQLite write failure must not replace a completed model-run result,
 * so failures are logged and the sweep continues.
 */
export async function removeInternalSessionEffectsSessions(
  targets: Iterable<AgentRunSessionTarget> | undefined,
): Promise<void> {
  for (const target of targets ?? []) {
    try {
      await removeInternalSessionEffectsSession(target);
    } catch (error) {
      log.warn(`failed to remove model-run SQLite session: ${coerceErrorMessage(error)}`);
    }
  }
}
