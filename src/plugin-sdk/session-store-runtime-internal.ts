import { MAIN_SESSION_RECOVERY_CLEAR_PATCH } from "../agents/main-session-recovery-clear.js";
import type { SessionAccessScope } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";

export type SessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  readConsistency?: "latest";
  sessionKey: string;
  storePath?: string;
};

export function toSessionAccessScope(params: SessionStoreReadParams): SessionAccessScope {
  // Keep plugin-facing options separate from internal accessor-only controls.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

export function projectPluginSessionEntry(entry: InternalSessionEntry): SessionEntry {
  const { mainRestartRecovery: _mainRestartRecovery, ...publicEntry } = entry;
  return {
    ...publicEntry,
    ...(entry.restartRecoveryRuns
      ? { restartRecoveryRuns: entry.restartRecoveryRuns.map((run) => ({ ...run })) }
      : {}),
  };
}

export function projectPluginSessionEntryPatch(
  patch: Partial<InternalSessionEntry>,
): Partial<SessionEntry> {
  const { mainRestartRecovery: _mainRestartRecovery, ...publicPatch } = patch;
  return publicPatch;
}

export function projectPluginSessionStore(
  store: Record<string, InternalSessionEntry>,
): Record<string, SessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([sessionKey, entry]) => [
      sessionKey,
      projectPluginSessionEntry(entry),
    ]),
  );
}

export function activeRecoveryFieldsForSameSession(
  existingEntry: InternalSessionEntry | undefined,
  nextSessionId: string | undefined,
): Partial<InternalSessionEntry> | undefined {
  if (
    !existingEntry ||
    existingEntry.sessionId !== nextSessionId ||
    existingEntry.mainRestartRecovery === undefined
  ) {
    return undefined;
  }
  return {
    abortedLastRun: existingEntry.abortedLastRun,
    restartRecoveryRuns: existingEntry.restartRecoveryRuns,
    mainRestartRecovery: existingEntry.mainRestartRecovery,
  };
}

export function clearRecoveryStateForRotatedSessionPatch(
  existingEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  return Object.hasOwn(publicPatch, "sessionId") &&
    publicPatch.sessionId !== existingEntry.sessionId
    ? { ...publicPatch, ...MAIN_SESSION_RECOVERY_CLEAR_PATCH }
    : publicPatch;
}

export function reconcilePluginSessionStore(params: {
  internalStore: Record<string, InternalSessionEntry>;
  publicStore: Record<string, SessionEntry>;
}): void {
  for (const sessionKey of Object.keys(params.internalStore)) {
    if (!Object.hasOwn(params.publicStore, sessionKey)) {
      delete params.internalStore[sessionKey];
    }
  }
  for (const [sessionKey, publicEntry] of Object.entries(params.publicStore)) {
    const projectedEntry = projectPluginSessionEntry(publicEntry as InternalSessionEntry);
    const existingRecovery = activeRecoveryFieldsForSameSession(
      params.internalStore[sessionKey],
      projectedEntry.sessionId,
    );
    const existingEntry = params.internalStore[sessionKey];
    params.internalStore[sessionKey] =
      existingEntry && existingEntry.sessionId !== projectedEntry.sessionId
        ? { ...projectedEntry, ...MAIN_SESSION_RECOVERY_CLEAR_PATCH }
        : existingRecovery
          ? { ...projectedEntry, ...existingRecovery }
          : projectedEntry;
  }
}
