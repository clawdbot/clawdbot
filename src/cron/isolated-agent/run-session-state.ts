/** Mutates and persists isolated cron session state around one run. */
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalAgentRuntimeId } from "../../agents/agent-runtime-id.js";
import { clearBootstrapSnapshotOnSessionBoundary } from "../../agents/bootstrap-cache.js";
import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import { setSessionRuntimeModel, type SessionEntry } from "../../config/sessions.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { readTranscriptStatsSync } from "../../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import { isSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import type {
  CronScheduledToolCallerOrigin,
  CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import type { resolveCronSession } from "./session.js";

type MutableSessionStore = Record<string, SessionEntry>;

function clearCronContextOwnerState(entry: SessionEntry) {
  delete entry.contextTokens;
  delete entry.contextTokensSource;
  delete entry.contextBudgetStatus;
}

/** Mutable cron session entry updated by an isolated run before persistence. */
type MutableCronSessionEntry = SessionEntry;
/** Resolved cron session plus its mutable backing store and active entry. */
export type MutableCronSession = ReturnType<typeof resolveCronSession> & {
  store: MutableSessionStore;
  sessionEntry: MutableCronSessionEntry;
};
/** Live provider/model/auth-profile selection reported by the running session. */
export type CronLiveSelection = LiveSessionModelSelection;

/**
 * Accessor-backed guarded write: `update` receives the freshest persisted row
 * (undefined when absent), may throw to reject a stale lifecycle claim, and
 * returns the full entry to commit. `fallbackEntry` seeds creation when the
 * row does not exist yet.
 */
type PersistSessionEntry = (params: {
  fallbackEntry: SessionEntry;
  resetBoundaryReason?: "cron-stale";
  sessionKey: string;
  storePath: string;
  update: (currentEntry: SessionEntry | undefined) => SessionEntry;
}) => Promise<void>;

/** Persists the currently selected mutable cron session entry to the session store. */
export type PersistCronSessionEntry = () => Promise<void>;

/** Hidden exact-run row retained while detached cron work can still resume. */
export type CronRunContinuationSession = {
  initialize: () => Promise<void>;
  sync: () => Promise<void>;
  setCliExecutionProvider: (provider?: string) => Promise<void>;
  seal: (options?: { basePersisted?: boolean }) => Promise<void>;
};

export class CronSessionLifecycleClaimError extends Error {
  readonly admissionDisposition = "session-conflict" as const;

  constructor(
    sessionKey: string,
    message = `Session "${sessionKey}" changed while starting work. Retry.`,
  ) {
    super(message);
    this.name = "CronSessionLifecycleClaimError";
  }
}

export function resolveCronLifecycleRevisionIdentity(lifecycleRevision: string): string {
  return `cron-lifecycle-revision:${lifecycleRevision}`;
}

function cronTranscriptExists(params: {
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): boolean {
  const sessionId = params.entry.sessionId?.trim();
  if (!sessionId) {
    return false;
  }
  try {
    return (
      readTranscriptStatsSync({
        sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      }).eventCount > 0
    );
  } catch {
    return false;
  }
}

function normalizeSessionField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function projectCronOwnershipFields(entry: SessionEntry): Partial<SessionEntry> {
  const projected: Partial<SessionEntry> = { ...entry };
  delete projected.label;
  delete projected.pinnedAt;
  delete projected.updatedAt;
  return projected;
}

function toNonResumableCronSessionEntry(entry: SessionEntry): SessionEntry {
  const next = { ...entry } as Partial<SessionEntry>;
  // If the transcript never materialized, do not persist stale resume handles
  // that would make the next cron run believe a resumable CLI session exists.
  delete next.sessionStartedAt;
  delete next.lastInteractionAt;
  delete next.cliSessionIds;
  delete next.cliSessionBindings;
  delete next.claudeCliSessionId;
  return next as SessionEntry;
}

/** Creates the persistence callback that stores cron session metadata after a run. */
export function createPersistCronSessionEntry(params: {
  cronSession: MutableCronSession;
  agentSessionKey: string;
  persistSessionEntry: PersistSessionEntry;
}): PersistCronSessionEntry {
  return async () => {
    const resetBoundaryPending = params.cronSession.resetBoundaryPending !== undefined;
    const liveEntry = params.cronSession.sessionEntry;
    const persistedEntry =
      isCronSessionKey(params.agentSessionKey) &&
      liveEntry.sessionId &&
      !cronTranscriptExists({
        entry: liveEntry,
        sessionKey: params.agentSessionKey,
        storePath: params.cronSession.storePath,
      })
        ? toNonResumableCronSessionEntry(liveEntry)
        : liveEntry;
    let committedEntry = persistedEntry;
    let mergedLiveEntry = liveEntry;
    const persistPromise = params.persistSessionEntry({
      storePath: params.cronSession.storePath,
      sessionKey: params.agentSessionKey,
      fallbackEntry: persistedEntry,
      ...(resetBoundaryPending ? { resetBoundaryReason: "cron-stale" as const } : {}),
      update: (currentEntry) => {
        if (!currentEntry) {
          const creationStamp = buildSessionCreationStamp({
            via: "cron",
            actor: { type: "system" },
          });
          committedEntry = { ...persistedEntry, ...creationStamp };
          mergedLiveEntry = { ...liveEntry, ...creationStamp };
        }
        const ownsCurrentRevision =
          currentEntry?.lifecycleRevision === params.cronSession.lifecycleRevision;
        const currentRevisionActive = Boolean(
          currentEntry?.lifecycleRevision &&
          isSessionWorkAdmissionActive(params.cronSession.storePath, [
            resolveCronLifecycleRevisionIdentity(currentEntry.lifecycleRevision),
          ]),
        );
        const initialEntryMatchesOwnershipFields =
          currentEntry !== undefined &&
          params.cronSession.initialSessionEntry !== undefined &&
          isDeepStrictEqual(
            projectCronOwnershipFields(currentEntry),
            projectCronOwnershipFields(params.cronSession.initialSessionEntry),
          );
        // Same-generation continuation: the row still carries the lifecycle
        // revision this run resolved from, so no competing run has claimed it
        // since. Benign concurrent field writes (delivery, token, status) then
        // merge into the claim instead of aborting it. Exact ownership-field
        // equality alone spuriously rejected these on large, busy stores where
        // such an update lands between resolve and this first persist.
        const initialEntry = params.cronSession.initialSessionEntry;
        const initialLifecycleRevision = initialEntry?.lifecycleRevision;
        const currentContinuesInitialGeneration =
          currentEntry !== undefined &&
          initialEntry !== undefined &&
          initialLifecycleRevision !== undefined &&
          currentEntry.lifecycleRevision === initialLifecycleRevision &&
          currentEntry.sessionId === initialEntry.sessionId;
        const canClaimInitialRevision = params.cronSession.initialSessionEntry
          ? !currentRevisionActive &&
            (initialEntryMatchesOwnershipFields || currentContinuesInitialGeneration)
          : currentEntry === undefined;
        // Concurrent persistent runs can resolve the same initial row. Once one
        // revision claims it, older owners must not reclaim it and delete newer state.
        if (!ownsCurrentRevision && !canClaimInitialRevision) {
          throw new CronSessionLifecycleClaimError(params.agentSessionKey);
        }
        if (
          (ownsCurrentRevision || canClaimInitialRevision) &&
          currentEntry &&
          params.cronSession.initialSessionEntry
        ) {
          committedEntry = mergeSessionSnapshotChanges({
            initial: params.cronSession.initialSessionEntry,
            next: persistedEntry,
            current: currentEntry,
          });
          mergedLiveEntry = mergeSessionSnapshotChanges({
            initial: params.cronSession.initialSessionEntry,
            next: liveEntry,
            current: currentEntry,
          });
        }
        return committedEntry;
      },
    });
    await persistPromise;
    clearBootstrapSnapshotOnSessionBoundary({
      boundaryAppended: resetBoundaryPending,
      sessionKey: params.agentSessionKey,
    });
    params.cronSession.resetBoundaryPending = undefined;
    // The storage projection may intentionally omit resume identity until its
    // transcript exists. Keep that projection out of the active run object.
    params.cronSession.sessionEntry = mergedLiveEntry;
    params.cronSession.initialSessionEntry = structuredClone(committedEntry);
    params.cronSession.store[params.agentSessionKey] = committedEntry;
  };
}

/** Creates the hidden exact-run session owner used by detached media wakes. */
export function createCronRunContinuationSession(params: {
  cronSession: MutableCronSession;
  runSessionKey: string;
  thinkingLevel?: string;
  toolsAllow?: string[];
  toolsAllowIsDefault?: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy;
  scheduledToolCallerOrigin?: CronScheduledToolCallerOrigin;
  cliSessionBindingFacts?: {
    extraSystemPromptStatic?: string;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    requireExplicitMessageTarget?: boolean;
  };
  persistSessionEntry: PersistSessionEntry;
}): CronRunContinuationSession {
  const scheduledToolPolicy =
    params.toolsAllow === undefined
      ? undefined
      : normalizeCronScheduledToolPolicy(params.scheduledToolPolicy);
  const scheduledToolCallerOrigin = normalizeCronScheduledToolCallerOrigin(
    params.scheduledToolCallerOrigin,
  );
  const continuation: NonNullable<SessionEntry["cronRunContinuation"]> = {
    lifecycleRevision: params.cronSession.lifecycleRevision,
    phase: "running" as const,
    ...(params.toolsAllow !== undefined ? { toolsAllow: [...params.toolsAllow] } : {}),
    ...(params.toolsAllowIsDefault === true ? { toolsAllowIsDefault: true } : {}),
    ...(scheduledToolPolicy ? { scheduledToolPolicy } : {}),
    ...(scheduledToolPolicy?.mode === "account" ? { scheduledToolCallerOrigin } : {}),
    ...(params.cliSessionBindingFacts
      ? { cliSessionBindingFacts: { ...params.cliSessionBindingFacts } }
      : {}),
  };
  const owns = (entry: SessionEntry | undefined) =>
    entry?.cronRunContinuation?.lifecycleRevision === continuation.lifecycleRevision;
  const persist = async (create: boolean, phase: "running" | "ready", basePersisted = false) => {
    const source = structuredClone(params.cronSession.sessionEntry);
    delete source.createdVia;
    delete source.createdActor;
    delete source.createdAt;
    // Node-local lineage must not leak across keys: the base row's generation
    // chain and fork ancestry describe the cron root, not this :run: node.
    delete source.previousSessionId;
    delete source.forkSource;
    let persisted = false;
    let alreadySealed = false;
    await params.persistSessionEntry({
      storePath: params.cronSession.storePath,
      sessionKey: params.runSessionKey,
      fallbackEntry: source,
      update: (current) => {
        if ((current && !owns(current)) || (!current && !create)) {
          throw new CronSessionLifecycleClaimError(params.runSessionKey);
        }
        // Leaving running transfers ownership to gateway continuation turns.
        // The initial cron owner must never overwrite their newer state.
        if (current && current.cronRunContinuation?.phase !== "running") {
          alreadySealed = phase === "ready" && current.cronRunContinuation?.phase === "ready";
          if (alreadySealed) {
            return current;
          }
          throw new CronSessionLifecycleClaimError(params.runSessionKey);
        }
        persisted = true;
        return {
          ...current,
          ...source,
          ...(!current
            ? buildSessionCreationStamp({ via: "cron", actor: { type: "system" } })
            : {}),
          ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
          cronRunContinuation: {
            ...continuation,
            phase,
            ...(phase === "ready" ? { basePersisted } : {}),
          },
        };
      },
    });
    if (!persisted && !alreadySealed) {
      throw new CronSessionLifecycleClaimError(params.runSessionKey);
    }
  };
  return {
    initialize: async () => await persist(true, "running"),
    sync: async () => await persist(false, "running"),
    setCliExecutionProvider: async (provider) => {
      const normalizedProvider = provider?.trim();
      if (normalizedProvider) {
        continuation.cliExecutionProvider = normalizedProvider;
      } else {
        delete continuation.cliExecutionProvider;
      }
      await persist(false, "running");
    },
    seal: async (options) => await persist(false, "ready", options?.basePersisted === true),
  };
}

/** Adopts the session id produced by a run and preserves usage-family lineage. */
export function adoptCronRunSessionMetadata(params: {
  entry: MutableCronSessionEntry;
  sessionKey: string;
  runMeta?: {
    sessionId?: string;
    sessionFile?: string;
  };
}): boolean {
  const nextSessionId = normalizeSessionField(params.runMeta?.sessionId);
  if (!nextSessionId) {
    return false;
  }

  let changed = false;
  const previousSessionId = params.entry.sessionId;
  if (nextSessionId && nextSessionId !== previousSessionId) {
    params.entry.sessionId = nextSessionId;
    params.entry.usageFamilyKey = params.entry.usageFamilyKey ?? params.sessionKey;
    params.entry.usageFamilySessionIds = Array.from(
      new Set([
        ...(params.entry.usageFamilySessionIds ?? []),
        ...(previousSessionId ? [previousSessionId] : []),
        nextSessionId,
      ]),
    );
    changed = true;
  }

  return changed;
}

/** Persists a changed skills snapshot onto the cron session entry outside fast tests. */
export async function persistCronSkillsSnapshotIfChanged(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  skillsSnapshot: SkillSnapshot;
  nowMs: number;
  persistSessionEntry: PersistCronSessionEntry;
}) {
  if (
    params.isFastTestEnv ||
    params.skillsSnapshot === params.cronSession.sessionEntry.skillsSnapshot
  ) {
    return;
  }
  params.cronSession.sessionEntry = {
    ...params.cronSession.sessionEntry,
    updatedAt: params.nowMs,
    skillsSnapshot: params.skillsSnapshot,
  };
  await params.persistSessionEntry();
}

/**
 * Updates the cron selection and drops facts produced by the previous model.
 * Keeping those facts after the owner tuple changes lets a later run relabel stale telemetry.
 */
export function setCronSessionRuntimeModel(params: {
  entry: MutableCronSessionEntry;
  provider: string;
  model: string;
}) {
  const provider = params.provider.trim();
  const model = params.model.trim();
  if (!provider || !model) {
    return false;
  }
  const selectionChanged =
    params.entry.modelProvider?.trim() !== provider || params.entry.model?.trim() !== model;
  if (selectionChanged) {
    clearCronContextOwnerState(params.entry);
  }
  setSessionRuntimeModel(params.entry, { provider, model });
  return selectionChanged;
}

/** Updates the producing harness and drops context facts owned by the previous runtime. */
export function setCronSessionAgentHarnessId(params: {
  entry: MutableCronSessionEntry;
  agentHarnessId: string | undefined;
}) {
  const previousRuntime = normalizeOptionalAgentRuntimeId(params.entry.agentHarnessId);
  const nextRuntime = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  if (previousRuntime !== nextRuntime) {
    clearCronContextOwnerState(params.entry);
  }
  params.entry.agentHarnessId = params.agentHarnessId;
  return previousRuntime !== nextRuntime;
}

/** Records the selected provider/model before a cron run starts. */
export function markCronSessionPreRun(params: {
  entry: MutableCronSessionEntry;
  provider: string;
  model: string;
}) {
  setCronSessionRuntimeModel(params);
  params.entry.systemSent = true;
}

/** Syncs live model/auth-profile changes from a running cron session back to storage. */
export function syncCronSessionLiveSelection(params: {
  entry: MutableCronSessionEntry;
  liveSelection: CronLiveSelection;
}) {
  const previousRuntime = normalizeOptionalAgentRuntimeId(params.entry.agentRuntimeOverride);
  const nextRuntime = normalizeOptionalAgentRuntimeId(params.liveSelection.agentRuntimeOverride);
  setCronSessionRuntimeModel({
    entry: params.entry,
    provider: params.liveSelection.provider,
    model: params.liveSelection.model,
  });
  if (previousRuntime !== nextRuntime) {
    clearCronContextOwnerState(params.entry);
  }
  if (params.liveSelection.agentRuntimeOverride) {
    params.entry.agentRuntimeOverride = params.liveSelection.agentRuntimeOverride;
  } else {
    delete params.entry.agentRuntimeOverride;
  }
  if (params.liveSelection.authProfileId) {
    const source =
      params.liveSelection.authProfileIdSource ??
      (params.entry.authProfileOverride?.trim() === params.liveSelection.authProfileId.trim()
        ? resolveSessionAuthProfileOverrideSource(params.entry)
        : "user");
    params.entry.authProfileOverride = params.liveSelection.authProfileId;
    params.entry.authProfileOverrideSource = source;
    if (source === "auto") {
      // Auto pins track their compaction generation; manual pins do not.
      params.entry.authProfileOverrideCompactionCount = params.entry.compactionCount ?? 0;
    } else {
      delete params.entry.authProfileOverrideCompactionCount;
    }
    return;
  }
  delete params.entry.authProfileOverride;
  delete params.entry.authProfileOverrideSource;
  delete params.entry.authProfileOverrideCompactionCount;
}
