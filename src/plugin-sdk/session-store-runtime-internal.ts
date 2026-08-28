import { MAIN_SESSION_RECOVERY_CLEAR_PATCH } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import type { SessionAccessScope } from "../config/sessions/session-accessor.js";
import {
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
  SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
} from "../config/sessions/session-entry-projection.js";
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
  const publicEntry = projectPublicSessionEntry(entry);
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
  return projectPublicSessionEntryPatch(patch);
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

export function generationValidPrivateFieldsForSameSession(
  existingEntry: InternalSessionEntry | undefined,
  nextSessionId: string | undefined,
  nextLifecycleRevision: string | undefined,
): Partial<InternalSessionEntry> | undefined {
  if (
    !existingEntry ||
    existingEntry.sessionId !== nextSessionId ||
    existingEntry.lifecycleRevision !== nextLifecycleRevision
  ) {
    return undefined;
  }
  const state: Partial<InternalSessionEntry> = {
    ...(existingEntry.activeWriterRunId !== undefined
      ? { activeWriterRunId: existingEntry.activeWriterRunId }
      : {}),
    ...(existingEntry.lifecycleRunId !== undefined
      ? { lifecycleRunId: existingEntry.lifecycleRunId }
      : {}),
    ...(existingEntry.pendingProjectGitUrl !== undefined
      ? { pendingProjectGitUrl: existingEntry.pendingProjectGitUrl }
      : {}),
    ...(existingEntry.sessionDiffBaselineCapture
      ? { sessionDiffBaselineCapture: existingEntry.sessionDiffBaselineCapture }
      : {}),
    ...(existingEntry.mainRestartRecovery
      ? {
          abortedLastRun: existingEntry.abortedLastRun,
          restartRecoveryRuns: existingEntry.restartRecoveryRuns,
          mainRestartRecovery: existingEntry.mainRestartRecovery,
        }
      : {}),
  };
  return Object.keys(state).length > 0 ? state : undefined;
}

export function clearGenerationPrivateFieldsForRotatedSessionPatch(
  existingEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  return (Object.hasOwn(publicPatch, "sessionId") &&
    publicPatch.sessionId !== existingEntry.sessionId) ||
    (Object.hasOwn(publicPatch, "lifecycleRevision") &&
      publicPatch.lifecycleRevision !== existingEntry.lifecycleRevision)
    ? {
        ...publicPatch,
        ...SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
        ...MAIN_SESSION_RECOVERY_CLEAR_PATCH,
      }
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
    const existingEntry = params.internalStore[sessionKey];
    const existingPrivateFields = generationValidPrivateFieldsForSameSession(
      existingEntry,
      projectedEntry.sessionId,
      projectedEntry.lifecycleRevision,
    );
    const generationRotated =
      existingEntry &&
      (existingEntry.sessionId !== projectedEntry.sessionId ||
        existingEntry.lifecycleRevision !== projectedEntry.lifecycleRevision);
    params.internalStore[sessionKey] = generationRotated
      ? {
          ...projectedEntry,
          ...SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
          ...MAIN_SESSION_RECOVERY_CLEAR_PATCH,
        }
      : existingPrivateFields
        ? { ...projectedEntry, ...existingPrivateFields }
        : projectedEntry;
  }
}
