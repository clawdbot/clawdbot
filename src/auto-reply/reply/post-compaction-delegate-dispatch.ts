import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { deriveContinuationDelegateChildSessionKey } from "../../agents/subagent-continuation-ids.js";
import {
  getSubagentRunByChildSessionKey,
  hasLiveContinuationDelegateChildRun,
} from "../../agents/subagent-registry-read.js";
import {
  spawnSubagentDirect,
  type SpawnSubagentContext,
  type SpawnSubagentParams,
  type SpawnSubagentResult,
} from "../../agents/subagent-spawn.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { resolveSessionStoreEntry, updateSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry, SessionPostCompactionDelegate } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveContinuationTraceparent } from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import {
  drainPendingSessionDeliveries,
  type SessionDeliveryRecoveryLogger,
} from "../../infra/session-delivery-queue-recovery.js";
import {
  enqueuePostCompactionDelegateDelivery,
  type QueuedSessionDelivery,
  type SessionDeliveryContext,
} from "../../infra/session-delivery-queue-storage.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import {
  assertStagedPostCompactionFinalizationComplete,
  consumeStagedPostCompactionDelegates,
  finalizeStagedPostCompactionDelegates,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  requeueReleasedPostCompactionDelegate,
  stagePostCompactionDelegate,
} from "../continuation-delegate-store.js";
import { resolveContinuationRuntimeConfig } from "../continuation/config.js";
import { hasCrossSessionDelegateTargeting } from "../continuation/targeting-pure.js";
import type { ContinuationRuntimeConfig } from "../continuation/types.js";
import type { ContinuationSignal } from "../tokens.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import type { FollowupRun } from "./queue/types.js";

export type QueuedPostCompactionDelegateDelivery = Extract<
  QueuedSessionDelivery,
  { kind: "postCompactionDelegate" }
>;

export type PostCompactionDelegateSpawn = (
  params: SpawnSubagentParams,
  context: SpawnSubagentContext,
) => Promise<SpawnSubagentResult>;

export type PostCompactionDelegateDeliveryDeps = {
  enqueueSystemEvent(
    text: string,
    options: { sessionKey: string; traceparent?: string; trusted?: boolean },
  ): void;
  getRuntimeConfig(): OpenClawConfig;
  loadSessionStore(storePath: string): Record<string, SessionEntry>;
  log(message: string): void;
  now(): number;
  resolveContinuationRuntimeConfig(cfg: OpenClawConfig): ContinuationRuntimeConfig;
  resolveSessionAgentId(params: { sessionKey?: string; config?: OpenClawConfig }): string;
  resolveStorePath(store?: string, opts?: { agentId?: string; env?: NodeJS.ProcessEnv }): string;
  spawnSubagentDirect: PostCompactionDelegateSpawn;
  markPendingDelegateSpawnAccepted(
    delegate: { flowId?: string; expectedRevision?: number; task: string },
    childSessionKey: string,
  ): boolean;
  markPendingDelegateFailed(
    delegate: { flowId?: string; expectedRevision?: number; task: string },
    blockedSummary: string,
    currentStep?: string,
  ): boolean;
};

export type PostCompactionDelegateDispatchDeps = {
  consumeStagedPostCompactionDelegates(sessionKey: string): SessionPostCompactionDelegate[];
  finalizeStagedPostCompactionDelegates(flowIds: readonly (string | undefined)[]): number;
  requeueReleasedPostCompactionDelegate(
    delegate: Pick<SessionPostCompactionDelegate, "flowId" | "expectedRevision" | "task">,
  ): boolean;
  stagePostCompactionDelegate(sessionKey: string, delegate: SessionPostCompactionDelegate): void;
  drainPostCompactionDelegateDeliveries(params: {
    entryIds?: readonly string[];
    log: SessionDeliveryRecoveryLogger;
    sessionKey: string;
  }): Promise<void>;
  enqueuePostCompactionDelegateDelivery(params: {
    sessionKey: string;
    delegate: SessionPostCompactionDelegate;
    sequence: number;
    compactionCount?: number;
    deliveryContext?: SessionDeliveryContext;
  }): Promise<string>;
  enqueueSystemEvent(
    text: string,
    options: { sessionKey: string; traceparent?: string; trusted?: boolean },
  ): void;
  log(message: string): void;
  now(): number;
  readPostCompactionContext(
    workspaceDir: string,
    options: { cfg: OpenClawConfig; agentId: string },
  ): Promise<string | null>;
  resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string): string;
  resolveContinuationRuntimeConfig(cfg: OpenClawConfig): ContinuationRuntimeConfig;
  resolveSessionAgentId(params: { sessionKey?: string; config?: OpenClawConfig }): string;
};

export type DispatchPostCompactionDelegatesParams = {
  cfg: OpenClawConfig;
  compactionCount: number | undefined;
  continuationSignalKind?: ContinuationSignal["kind"];
  followupRun: FollowupRun;
  postCompactionDelegatesToPreserve: SessionPostCompactionDelegate[];
  releaseTraceparent?: string;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
};

export type DispatchPostCompactionDelegatesResult = {
  queuedDelegates: number;
  droppedDelegates: number;
};

const defaultRecoveryLog: SessionDeliveryRecoveryLogger = {
  info: (message) => defaultRuntime.log(message),
  warn: (message) => defaultRuntime.log(message),
  error: (message) => defaultRuntime.log(message),
};

const defaultPostCompactionDelegateDeliveryDeps: PostCompactionDelegateDeliveryDeps = {
  enqueueSystemEvent,
  getRuntimeConfig,
  loadSessionStore,
  log: (message) => defaultRuntime.log(message),
  now: () => Date.now(),
  resolveContinuationRuntimeConfig,
  resolveSessionAgentId,
  resolveStorePath,
  spawnSubagentDirect,
  markPendingDelegateSpawnAccepted,
  markPendingDelegateFailed,
};

const defaultPostCompactionDelegateDispatchDeps: PostCompactionDelegateDispatchDeps = {
  consumeStagedPostCompactionDelegates,
  finalizeStagedPostCompactionDelegates,
  requeueReleasedPostCompactionDelegate,
  stagePostCompactionDelegate,
  drainPostCompactionDelegateDeliveries,
  enqueuePostCompactionDelegateDelivery,
  enqueueSystemEvent,
  log: (message) => defaultRuntime.log(message),
  now: () => Date.now(),
  readPostCompactionContext,
  resolveAgentWorkspaceDir,
  resolveContinuationRuntimeConfig,
  resolveSessionAgentId,
};

export const POST_COMPACTION_DELEGATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function enqueueSystemEventOrLog(params: {
  deps: Pick<PostCompactionDelegateDispatchDeps, "enqueueSystemEvent" | "log">;
  label: string;
  sessionKey: string;
  text: string;
}): void {
  try {
    params.deps.enqueueSystemEvent(params.text, { sessionKey: params.sessionKey });
  } catch (err) {
    params.deps.log(
      `Failed to enqueue ${params.label} for ${params.sessionKey}: ${formatErrorMessage(err)}`,
    );
  }
}

function syncPendingPostCompactionDelegates(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  delegates: SessionPostCompactionDelegate[] | undefined;
}) {
  if (params.sessionEntry) {
    params.sessionEntry.pendingPostCompactionDelegates = params.delegates;
  }
  const storedEntry = params.sessionStore?.[params.sessionKey];
  if (storedEntry && params.sessionStore) {
    params.sessionStore[params.sessionKey] = {
      ...storedEntry,
      pendingPostCompactionDelegates: params.delegates,
    };
  }
}

export function normalizePostCompactionDelegate(
  delegate: SessionPostCompactionDelegate,
): SessionPostCompactionDelegate {
  const legacySilentWake = delegate.silent == null && delegate.silentWake == null;
  const silentWake = legacySilentWake ? true : delegate.silentWake === true;
  const silent = legacySilentWake ? true : delegate.silent === true || silentWake;
  const firstArmedAt = delegate.firstArmedAt ?? delegate.createdAt;
  const internalTraceparent =
    delegate.traceparentProvenance === "internal"
      ? resolveContinuationTraceparent(delegate.traceparent)
      : undefined;

  return {
    task: delegate.task,
    createdAt: delegate.createdAt,
    firstArmedAt,
    ...(delegate.silent != null || legacySilentWake ? { silent } : {}),
    ...(delegate.silentWake != null || legacySilentWake ? { silentWake } : {}),
    ...(delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {}),
    ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
      ? { targetSessionKeys: delegate.targetSessionKeys }
      : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(internalTraceparent
      ? {
          traceparent: internalTraceparent,
          traceparentProvenance: "internal" as const,
        }
      : {}),
    ...(delegate.model ? { model: delegate.model } : {}),
  };
}

function formatTaskPreview(task: string): string {
  return JSON.stringify(task.length > 120 ? `${task.slice(0, 117)}...` : task);
}

export async function persistPendingPostCompactionDelegates(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  delegates: SessionPostCompactionDelegate[];
}): Promise<SessionPostCompactionDelegate[]> {
  if (params.delegates.length === 0) {
    return (params.sessionEntry?.pendingPostCompactionDelegates ?? []).map(
      normalizePostCompactionDelegate,
    );
  }

  const normalizedDelegates = params.delegates.map(normalizePostCompactionDelegate);
  const localExisting = (params.sessionEntry?.pendingPostCompactionDelegates ?? []).map(
    normalizePostCompactionDelegate,
  );
  const combinedLocal = [...localExisting, ...normalizedDelegates];

  if (!params.storePath) {
    syncPendingPostCompactionDelegates({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      delegates: combinedLocal,
    });
    return combinedLocal;
  }

  const persisted = await updateSessionStore(params.storePath, (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const current =
      resolved.existing ??
      params.sessionStore?.[params.sessionKey] ??
      params.sessionEntry ??
      undefined;
    const combined = [
      ...(current?.pendingPostCompactionDelegates ?? []).map(normalizePostCompactionDelegate),
      ...normalizedDelegates,
    ];
    if (current) {
      store[resolved.normalizedKey] = {
        ...current,
        pendingPostCompactionDelegates: combined,
      };
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
    }
    return combined;
  });

  syncPendingPostCompactionDelegates({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    delegates: persisted.length > 0 ? persisted : combinedLocal,
  });
  return persisted.length > 0 ? persisted : combinedLocal;
}

export async function takePendingPostCompactionDelegates(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
}): Promise<SessionPostCompactionDelegate[]> {
  const localDelegates = (params.sessionEntry?.pendingPostCompactionDelegates ?? []).map(
    normalizePostCompactionDelegate,
  );

  if (!params.storePath) {
    syncPendingPostCompactionDelegates({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      delegates: undefined,
    });
    return localDelegates;
  }

  const persisted = await updateSessionStore(params.storePath, (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const current =
      resolved.existing ??
      params.sessionStore?.[params.sessionKey] ??
      params.sessionEntry ??
      undefined;
    const delegates = (current?.pendingPostCompactionDelegates ?? []).map(
      normalizePostCompactionDelegate,
    );
    if (current && delegates.length > 0) {
      store[resolved.normalizedKey] = {
        ...current,
        pendingPostCompactionDelegates: undefined,
      };
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
    }
    return delegates;
  });

  syncPendingPostCompactionDelegates({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    delegates: undefined,
  });
  return persisted.length > 0 ? persisted : localDelegates;
}

export function buildPostCompactionLifecycleEvent(params: {
  compactionCount?: number;
  /**
   * Number of delegates accepted into the persistent delivery queue this
   * dispatch. NOTE: this is the queued count (post-`enqueue` accept,
   * pre-spawn). The actual spawn happens asynchronously in the
   * fire-and-forget drain triggered after this event is emitted, so this
   * count is an upper bound on what will eventually be released into the
   * fresh session — individual queued entries may still fail to spawn
   * (their failure is recorded as a queue retry, not reflected here).
   *
   * Named `queuedDelegates` to make the semantic accurate; the previous
   * agent-runner path counted accepted
   * spawns, but the queue-extraction architecture cannot count spawns
   * synchronously without awaiting the drain. The honest name is
   * `queuedDelegates`.
   */
  queuedDelegates: number;
  droppedDelegates: number;
}): string {
  const parts = [
    `[system:post-compaction] Session compacted at ${new Date().toISOString()}.`,
    typeof params.compactionCount === "number"
      ? `Compaction count: ${params.compactionCount}.`
      : undefined,
    `Queued ${params.queuedDelegates} post-compaction delegate(s) for delivery into the fresh session.`,
    params.droppedDelegates > 0
      ? `${params.droppedDelegates} delegate(s) were not released into the fresh session.`
      : undefined,
  ].filter(Boolean);
  return parts.join(" ");
}

function failSourceBackedPostCompactionDelivery(
  deps: Pick<PostCompactionDelegateDeliveryDeps, "markPendingDelegateFailed" | "log">,
  entry: QueuedPostCompactionDelegateDelivery,
  summary: string,
): void {
  if (!entry.sourceFlowId || entry.sourceExpectedRevision === undefined) {
    return;
  }
  const applied = deps.markPendingDelegateFailed(
    {
      flowId: entry.sourceFlowId,
      expectedRevision: entry.sourceExpectedRevision,
      task: entry.task,
    },
    summary,
    "Post-compaction delegate rejected",
  );
  if (!applied) {
    throw new Error(
      `[continuation:post-compaction-source-fail-not-committed] flowId=${entry.sourceFlowId} reason=${summary}`,
    );
  }
}

function maybeFinalizePreviouslyAcceptedSourceBackedDelivery(params: {
  acceptedChildSessionKey: string | undefined;
  deps: PostCompactionDelegateDeliveryDeps;
  entry: QueuedPostCompactionDelegateDelivery;
}): boolean {
  const { acceptedChildSessionKey, deps, entry } = params;
  if (
    !entry.sourceFlowId ||
    entry.sourceExpectedRevision === undefined ||
    !acceptedChildSessionKey
  ) {
    return false;
  }
  if (
    !getSubagentRunByChildSessionKey(acceptedChildSessionKey) &&
    !hasLiveContinuationDelegateChildRun({
      childSessionKey: acceptedChildSessionKey,
      flowId: entry.sourceFlowId,
    })
  ) {
    return false;
  }
  const committed = deps.markPendingDelegateSpawnAccepted(
    {
      flowId: entry.sourceFlowId,
      expectedRevision: entry.sourceExpectedRevision,
      task: entry.task,
    },
    acceptedChildSessionKey,
  );
  if (!committed) {
    throw new Error(
      `[continuation:post-compaction-source-accept-not-committed] flowId=${entry.sourceFlowId}`,
    );
  }
  const entryTraceparent = resolveQueuedPostCompactionTraceparent(entry);
  deps.enqueueSystemEvent(
    `[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: ${entry.task}`,
    {
      sessionKey: entry.sessionKey,
      ...(entryTraceparent ? { traceparent: entryTraceparent } : {}),
    },
  );
  deps.log(
    `[continuation:post-compaction-source-accepted-recovered] flowId=${entry.sourceFlowId} child=${acceptedChildSessionKey}`,
  );
  return true;
}

async function persistPostCompactionDelegateChainState(params: {
  count: number;
  log: (message: string) => void;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  sessionStore?: Record<string, SessionEntry>;
  startedAt: number;
  storePath?: string;
  tokens: number;
}): Promise<{ chainId: string }> {
  // Mint or reuse `continuationChainId` (UUID) so the post-compaction
  // handoff carries the same correlation key that
  // `agent-runner.ts:persistContinuationChainState` would have used
  // before compaction. If the pre-compaction sessionEntry already had
  // a chain id, reuse it (chain survives the compaction boundary);
  // otherwise mint fresh (this is the chain's first persisted step
  // post-handoff).
  const previousChainId = params.sessionEntry?.continuationChainId;
  const chainId = previousChainId ?? generateChainId();
  if (params.sessionEntry) {
    params.sessionEntry.continuationChainCount = params.count;
    params.sessionEntry.continuationChainStartedAt = params.startedAt;
    params.sessionEntry.continuationChainTokens = params.tokens;
    params.sessionEntry.continuationChainId = chainId;
  }
  if (params.sessionStore) {
    const resolved = resolveSessionStoreEntry({
      store: params.sessionStore,
      sessionKey: params.sessionKey,
    });
    const existingEntry =
      resolved.existing ?? params.sessionStore[params.sessionKey] ?? params.sessionEntry;
    if (existingEntry) {
      params.sessionStore[resolved.normalizedKey] = {
        ...existingEntry,
        continuationChainCount: params.count,
        continuationChainStartedAt: params.startedAt,
        continuationChainTokens: params.tokens,
        continuationChainId: chainId,
      };
      for (const legacyKey of resolved.legacyKeys) {
        delete params.sessionStore[legacyKey];
      }
    }
  }
  if (params.storePath) {
    try {
      await updateSessionStore(
        params.storePath,
        (store) => {
          const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
          const existingEntry = resolved.existing ?? store[params.sessionKey];
          if (existingEntry) {
            store[resolved.existing ? resolved.normalizedKey : params.sessionKey] = {
              ...existingEntry,
              continuationChainCount: params.count,
              continuationChainStartedAt: params.startedAt,
              continuationChainTokens: params.tokens,
              continuationChainId: chainId,
            };
            if (resolved.existing) {
              for (const legacyKey of resolved.legacyKeys) {
                delete store[legacyKey];
              }
            }
          }
        },
        { requireWriteSuccess: true },
      );
    } catch (err) {
      params.log(
        `Failed to persist post-compaction delegate chain state for ${params.sessionKey}: ${String(
          err,
        )}`,
      );
      // Rethrow so `deliverQueuedPostCompactionDelegate` rejects, the queue
      // entry stays in `pending/` with a bumped retryCount, and the next
      // unfiltered drain re-considers it once backoff has elapsed. With the
      // persist-then-spawn ordering this is doubly safe: the persist runs
      // BEFORE the subagent spawn, so a persist failure means no child was
      // spawned and the retry re-attempts cleanly (no duplicate). It also keeps
      // the on-disk chain count from going stale relative to the queue, which
      // would otherwise let the next compaction-delegate overrun
      // `maxChainLength`.
      throw err;
    }
  }
  return { chainId };
}

function resolvePostCompactionDeliveryContext(
  followupRun: FollowupRun,
): SessionDeliveryContext | undefined {
  const deliveryContext: SessionDeliveryContext = {
    ...(followupRun.originatingChannel ? { channel: followupRun.originatingChannel } : {}),
    ...(followupRun.originatingTo ? { to: followupRun.originatingTo } : {}),
    ...(followupRun.originatingAccountId ? { accountId: followupRun.originatingAccountId } : {}),
    ...(followupRun.originatingThreadId != null
      ? { threadId: followupRun.originatingThreadId }
      : {}),
  };
  return Object.keys(deliveryContext).length > 0 ? deliveryContext : undefined;
}

function isPostCompactionDelegateEntry(
  entry: QueuedSessionDelivery,
): entry is QueuedPostCompactionDelegateDelivery {
  return entry.kind === "postCompactionDelegate";
}

function resolveQueuedPostCompactionTraceparent(
  entry: QueuedPostCompactionDelegateDelivery,
): string | undefined {
  return entry.traceparentProvenance === "internal"
    ? resolveContinuationTraceparent(entry.traceparent)
    : undefined;
}

function applyReleaseTraceparent(
  delegate: SessionPostCompactionDelegate,
  releaseTraceparent: string | undefined,
): SessionPostCompactionDelegate {
  if (delegate.traceparentProvenance === "internal" && delegate.traceparent) {
    return delegate;
  }
  const resolvedReleaseTraceparent = resolveContinuationTraceparent(releaseTraceparent);
  if (!resolvedReleaseTraceparent) {
    const normalized = { ...delegate };
    delete normalized.traceparent;
    delete normalized.traceparentProvenance;
    return normalized;
  }
  return {
    ...delegate,
    traceparent: resolvedReleaseTraceparent,
    traceparentProvenance: "internal",
  };
}

export async function deliverQueuedPostCompactionDelegate(
  params: {
    entry: QueuedPostCompactionDelegateDelivery;
  },
  deps: PostCompactionDelegateDeliveryDeps = defaultPostCompactionDelegateDeliveryDeps,
): Promise<void> {
  const entryTraceparent = resolveQueuedPostCompactionTraceparent(params.entry);
  const cfg = deps.getRuntimeConfig();
  const agentId = deps.resolveSessionAgentId({
    sessionKey: params.entry.sessionKey,
    config: cfg,
  });
  const sourceAcceptedChildSessionKey = params.entry.sourceFlowId
    ? deriveContinuationDelegateChildSessionKey(agentId, params.entry.sourceFlowId)
    : undefined;
  if (
    maybeFinalizePreviouslyAcceptedSourceBackedDelivery({
      acceptedChildSessionKey: sourceAcceptedChildSessionKey,
      deps,
      entry: params.entry,
    })
  ) {
    return;
  }
  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
  const sessionStore = deps.loadSessionStore(storePath);
  const resolved = resolveSessionStoreEntry({
    store: sessionStore,
    sessionKey: params.entry.sessionKey,
  });
  const sessionEntry = resolved.existing ?? sessionStore[params.entry.sessionKey];
  const {
    maxChainLength: maxCompactionChainLength,
    costCapTokens: compactionCostCapTokens,
    crossSessionTargeting,
  } = deps.resolveContinuationRuntimeConfig(cfg);
  const currentCompactionChainCount = sessionEntry?.continuationChainCount ?? 0;
  const compactionChainTokens = sessionEntry?.continuationChainTokens ?? 0;

  if (currentCompactionChainCount >= maxCompactionChainLength) {
    deps.log(
      `Post-compaction delegate rejected: chain length ${currentCompactionChainCount} >= ${maxCompactionChainLength} for session ${params.entry.sessionKey}`,
    );
    deps.enqueueSystemEvent(
      `[continuation] Post-compaction delegate rejected: chain length ${maxCompactionChainLength} reached. Task: ${params.entry.task}`,
      {
        sessionKey: params.entry.sessionKey,
        ...(entryTraceparent ? { traceparent: entryTraceparent } : {}),
      },
    );
    failSourceBackedPostCompactionDelivery(
      deps,
      params.entry,
      `Post-compaction delegate rejected: chain length ${maxCompactionChainLength} reached.`,
    );
    return;
  }

  if (compactionCostCapTokens > 0 && compactionChainTokens > compactionCostCapTokens) {
    deps.log(
      `Post-compaction delegate rejected: cost cap exceeded (${compactionChainTokens} > ${compactionCostCapTokens}) for session ${params.entry.sessionKey}`,
    );
    deps.enqueueSystemEvent(
      `[continuation] Post-compaction delegate rejected: cost cap exceeded (${compactionChainTokens} > ${compactionCostCapTokens}). Task: ${params.entry.task}`,
      {
        sessionKey: params.entry.sessionKey,
        ...(entryTraceparent ? { traceparent: entryTraceparent } : {}),
      },
    );
    failSourceBackedPostCompactionDelivery(
      deps,
      params.entry,
      `Post-compaction delegate rejected: cost cap exceeded (${compactionChainTokens} > ${compactionCostCapTokens}).`,
    );
    return;
  }

  if (
    crossSessionTargeting === "disabled" &&
    hasCrossSessionDelegateTargeting(params.entry, params.entry.sessionKey)
  ) {
    deps.log(
      `Post-compaction delegate rejected: crossSessionTargeting=disabled at delivery time for session ${params.entry.sessionKey}`,
    );
    deps.enqueueSystemEvent(
      `[continuation] Post-compaction delegate rejected: cross-session targeting was disabled at delivery time. Task: ${params.entry.task}`,
      {
        sessionKey: params.entry.sessionKey,
        ...(entryTraceparent ? { traceparent: entryTraceparent } : {}),
      },
    );
    failSourceBackedPostCompactionDelivery(
      deps,
      params.entry,
      "Post-compaction delegate rejected: cross-session targeting was disabled at delivery time.",
    );
    return;
  }

  const nextCompactionChainCount = currentCompactionChainCount + 1;
  const compactionChainStartedAt = sessionEntry?.continuationChainStartedAt ?? deps.now();
  deps.log(
    `Post-compaction delegate dispatch for session ${params.entry.sessionKey}: ${params.entry.task}`,
  );
  const delegateWakeOnReturn = params.entry.silentWake ?? true;
  const delegateSilentAnnounce = params.entry.silent ?? delegateWakeOnReturn;

  // Persist the advanced chain-count BEFORE spawning (persist-then-spawn), so the
  // chain-count update and the spawn fail safe in the only direction that protects
  // `maxChainLength`:
  //   - persist throws (disk/SQLite) -> we throw before spawning, the queue entry
  //     stays pending, and the next drain retries cleanly with NO child spawned
  //     yet. This is the fix for the duplicate-delegate bug: there is no accepted
  //     spawn to duplicate when the persist fails.
  //   - spawn fails after a successful persist -> the count was advanced for a
  //     delegate that did not start. That is the SAFE direction: an over-count only
  //     makes `maxChainLength` *more* protective (the chain terminates earlier),
  //     never overruns it. (A retry re-reads the advanced count and may bump again
  //     on repeated spawn failures; that compounds conservatively, never past the
  //     guard, and repeated spawn failures are anomalous.)
  // The previous spawn-then-persist order had the opposite, unsafe failure: an
  // accepted spawn whose persist then threw left the queue entry pending, so the
  // next drain re-spawned the SAME delegate (duplicated work). See cmt451.
  const persistedChain = await persistPostCompactionDelegateChainState({
    count: nextCompactionChainCount,
    log: (message) => deps.log(message),
    sessionEntry,
    sessionKey: params.entry.sessionKey,
    sessionStore,
    startedAt: compactionChainStartedAt,
    storePath,
    tokens: compactionChainTokens,
  });

  const spawnResult = await deps.spawnSubagentDirect(
    {
      task:
        `[continuation:post-compaction] ` +
        `[continuation:chain-hop:${nextCompactionChainCount}] ` +
        `Compaction just completed. Carry this working state to the post-compaction session: ${params.entry.task}`,
      ...(delegateSilentAnnounce ? { silentAnnounce: true } : {}),
      ...(delegateWakeOnReturn ? { silentAnnounce: true, wakeOnReturn: true } : {}),
      ...(params.entry.targetSessionKey
        ? { continuationTargetSessionKey: params.entry.targetSessionKey }
        : {}),
      ...(params.entry.targetSessionKeys && params.entry.targetSessionKeys.length > 0
        ? { continuationTargetSessionKeys: params.entry.targetSessionKeys }
        : {}),
      ...(params.entry.fanoutMode ? { continuationFanoutMode: params.entry.fanoutMode } : {}),
      drainsContinuationDelegateQueue: true,
      continuationDelegateFlowId: params.entry.sourceFlowId ?? params.entry.id,
      continuationChainState: {
        count: nextCompactionChainCount,
        startedAt: compactionChainStartedAt,
        tokens: compactionChainTokens,
        chainId: persistedChain.chainId,
      },
      ...(params.entry.model ? { model: params.entry.model } : {}),
      ...(entryTraceparent ? { traceparent: entryTraceparent } : {}),
    },
    {
      agentSessionKey: params.entry.sessionKey,
      agentChannel: params.entry.deliveryContext?.channel,
      agentAccountId: params.entry.deliveryContext?.accountId,
      agentTo: params.entry.deliveryContext?.to,
      agentThreadId: params.entry.deliveryContext?.threadId,
    },
  );
  if (spawnResult.status !== "accepted") {
    if (
      spawnResult.status === "forbidden" &&
      params.entry.sourceFlowId &&
      params.entry.sourceExpectedRevision !== undefined
    ) {
      failSourceBackedPostCompactionDelivery(
        deps,
        params.entry,
        `Post-compaction delegate spawn forbidden: ${spawnResult.error ?? "delegation was not accepted"}.`,
      );
      return;
    }
    throw new Error(`post-compaction delegate spawn ${spawnResult.status}`);
  }
  if (params.entry.sourceFlowId && params.entry.sourceExpectedRevision !== undefined) {
    const acceptedChildSessionKey = spawnResult.childSessionKey ?? sourceAcceptedChildSessionKey!;
    const committed = deps.markPendingDelegateSpawnAccepted(
      {
        flowId: params.entry.sourceFlowId,
        expectedRevision: params.entry.sourceExpectedRevision,
        task: params.entry.task,
      },
      acceptedChildSessionKey,
    );
    if (!committed) {
      throw new Error(
        `[continuation:post-compaction-source-accept-not-committed] flowId=${params.entry.sourceFlowId}`,
      );
    }
  }

  deps.enqueueSystemEvent(
    `[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: ${params.entry.task}`,
    {
      sessionKey: params.entry.sessionKey,
      ...(entryTraceparent ? { traceparent: entryTraceparent } : {}),
    },
  );
}

export async function drainPostCompactionDelegateDeliveries(params: {
  entryIds?: readonly string[];
  log?: SessionDeliveryRecoveryLogger;
  sessionKey?: string;
  stateDir?: string;
  deliveryDeps?: PostCompactionDelegateDeliveryDeps;
}): Promise<void> {
  const entryIds = new Set(params.entryIds ?? []);
  await drainPendingSessionDeliveries({
    drainKey: `post-compaction-delegate:${params.sessionKey ?? "all"}`,
    logLabel: "post-compaction delegate",
    log: params.log ?? defaultRecoveryLog,
    stateDir: params.stateDir,
    deliver: async (entry) => {
      if (!isPostCompactionDelegateEntry(entry)) {
        return;
      }
      await deliverQueuedPostCompactionDelegate({ entry }, params.deliveryDeps);
    },
    selectEntry: (entry) => ({
      match:
        isPostCompactionDelegateEntry(entry) &&
        (params.sessionKey == null || entry.sessionKey === params.sessionKey) &&
        (entryIds.size === 0 || entryIds.has(entry.id)),
      bypassBackoff: entryIds.size > 0,
    }),
  });
}

export async function dispatchPostCompactionDelegates(
  params: DispatchPostCompactionDelegatesParams,
  deps: PostCompactionDelegateDispatchDeps = defaultPostCompactionDelegateDispatchDeps,
): Promise<DispatchPostCompactionDelegatesResult> {
  const internalReleaseTraceparent = resolveContinuationTraceparent(params.releaseTraceparent);
  const stagedCompactionDelegates = deps.consumeStagedPostCompactionDelegates(params.sessionKey);
  // Capture the claim handles immediately: consumeStagedPostCompactionDelegates
  // now claims TaskFlow rows to `running` (not `finished`), and we finalize ONLY
  // these specific rows after the durable handoff below — never other running
  // rows for the session (e.g. crash-orphaned ones awaiting recovery) (#1144).
  const claimedFlowIds = stagedCompactionDelegates.map((delegate) => delegate.flowId);
  let persistedCompactionDelegates: SessionPostCompactionDelegate[] = [];
  try {
    persistedCompactionDelegates = await takePendingPostCompactionDelegates({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  } catch (err) {
    const message = formatErrorMessage(err);
    deps.log(`Failed to load post-compaction delegates for ${params.sessionKey}: ${message}`);
    enqueueSystemEventOrLog({
      deps,
      label: "persisted post-compaction delegate warning",
      sessionKey: params.sessionKey,
      text:
        `[system:continuation-warning] Failed to load persisted post-compaction delegates for this session: ${message}. ` +
        "Earlier turns may have staged delegates that will not fire. Re-stage critical post-compaction work.",
    });
  }
  const allCompactionDelegates = [
    ...persistedCompactionDelegates,
    ...stagedCompactionDelegates,
  ].map((delegate) => {
    const normalized = applyReleaseTraceparent(
      normalizePostCompactionDelegate(delegate),
      internalReleaseTraceparent,
    );
    if (delegate.flowId) {
      normalized.flowId = delegate.flowId;
    }
    if (delegate.expectedRevision !== undefined) {
      normalized.expectedRevision = delegate.expectedRevision;
    }
    return normalized;
  });
  const now = deps.now();
  const freshCompactionDelegates: SessionPostCompactionDelegate[] = [];
  let staleDroppedDelegates = 0;
  for (const delegate of allCompactionDelegates) {
    const ageMs = now - (delegate.firstArmedAt ?? delegate.createdAt);
    if (ageMs > POST_COMPACTION_DELEGATE_TTL_MS) {
      staleDroppedDelegates += 1;
      deps.log(
        `Post-compaction delegate dropped as stale for ${params.sessionKey}: ageMs=${ageMs} ttlMs=${POST_COMPACTION_DELEGATE_TTL_MS} firstArmedAt=${delegate.firstArmedAt ?? delegate.createdAt} task=${formatTaskPreview(delegate.task)}`,
      );
      continue;
    }
    freshCompactionDelegates.push(delegate);
  }

  // Enforce maxDelegatesPerTurn budget. Account for any bracket-style delegate
  // already spawned this turn so the combined per-turn count cannot exceed
  // the configured cap. Mirrors the pre-extraction behavior at
  // src/auto-reply/reply/agent-runner.ts (pre-cdc9b6ecd54).
  const { maxDelegatesPerTurn: maxCompactionDelegates } = deps.resolveContinuationRuntimeConfig(
    params.cfg,
  );
  const bracketDelegateOffset = params.continuationSignalKind === "delegate" ? 1 : 0;
  const compactionBudget = Math.max(0, maxCompactionDelegates - bracketDelegateOffset);
  const releasedCompactionDelegates = freshCompactionDelegates.slice(0, compactionBudget);
  const overflowDroppedDelegates = Math.max(
    0,
    freshCompactionDelegates.length - releasedCompactionDelegates.length,
  );
  if (overflowDroppedDelegates > 0) {
    deps.log(
      `Post-compaction delegates dropped for ${params.sessionKey}: ${overflowDroppedDelegates} over maxDelegatesPerTurn budget (${maxCompactionDelegates}, bracketOffset=${bracketDelegateOffset})`,
    );
  }

  let postCompactionContextContent: string | null = null;
  try {
    postCompactionContextContent = await deps.readPostCompactionContext(
      typeof params.followupRun.run.workspaceDir === "string" &&
        params.followupRun.run.workspaceDir.trim()
        ? params.followupRun.run.workspaceDir
        : deps.resolveAgentWorkspaceDir(params.cfg, params.followupRun.run.agentId),
      {
        cfg: params.cfg,
        agentId: deps.resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg }),
      },
    );
  } catch (err) {
    const message = formatErrorMessage(err);
    deps.log(
      `[continuation:post-compaction-context-read-failed] sessionKey=${params.sessionKey} error=${message}`,
    );
    enqueueSystemEventOrLog({
      deps,
      label: "post-compaction context read failure",
      sessionKey: params.sessionKey,
      text:
        `[system:post-compaction] Context evacuation read failed: ${message}. ` +
        "The post-compaction session may be missing AGENTS.md/RESUMPTION.md content. Check workspace permissions and re-run if needed.",
    });
  }

  const deliveryContext = resolvePostCompactionDeliveryContext(params.followupRun);
  const enqueueResults = await Promise.allSettled(
    releasedCompactionDelegates.map((delegate, sequence) =>
      deps.enqueuePostCompactionDelegateDelivery({
        sessionKey: params.sessionKey,
        delegate,
        sequence,
        compactionCount: params.compactionCount,
        ...(deliveryContext ? { deliveryContext } : {}),
      }),
    ),
  );

  const queuedEntryIds: string[] = [];
  let droppedCompactionDelegates = staleDroppedDelegates + overflowDroppedDelegates;
  for (const [index, result] of enqueueResults.entries()) {
    if (result.status === "fulfilled") {
      queuedEntryIds.push(result.value);
      continue;
    }
    droppedCompactionDelegates += 1;
    const delegate = releasedCompactionDelegates[index];
    if (delegate) {
      params.postCompactionDelegatesToPreserve.push(delegate);
    }
    deps.log(
      `Failed to enqueue post-compaction delegate for ${params.sessionKey} (re-staged): ${String(
        result.reason,
      )}`,
    );
  }

  const requeuedClaimedFlowIds = new Set<string>();
  if (params.postCompactionDelegatesToPreserve.length > 0) {
    const delegatesToPersist: SessionPostCompactionDelegate[] = [];
    for (const delegate of params.postCompactionDelegatesToPreserve) {
      if (deps.requeueReleasedPostCompactionDelegate(delegate)) {
        requeuedClaimedFlowIds.add(delegate.flowId!);
        continue;
      }
      delegatesToPersist.push(delegate);
    }
    try {
      if (delegatesToPersist.length > 0) {
        await persistPendingPostCompactionDelegates({
          sessionEntry: params.sessionEntry,
          sessionStore: params.sessionStore,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          delegates: delegatesToPersist,
        });
      }
    } catch (err) {
      // Session-store persist failed. Re-stage the delegates as fresh queued
      // TaskFlow rows NOW — before finalizing the claimed rows — so they stay
      // durably recoverable WITHOUT leaving the original claimed rows `running`.
      // Leaving them running would let startup recovery
      // (listRecoverableStagedPostCompactionDelegates) re-dispatch delegates
      // that were already delivered or re-staged (#1144). Mirrors the
      // agent-runner post-compaction finalize path.
      const restagedCount = delegatesToPersist.length;
      for (const delegate of delegatesToPersist) {
        deps.stagePostCompactionDelegate(params.sessionKey, delegate);
      }
      deps.log(
        `Failed to persist re-staged post-compaction delegates for ${params.sessionKey}; re-staged ${restagedCount} to the durable queue: ${String(
          err,
        )}`,
      );
    }
    // Cleared on both paths: the delegates are now durable (session store on
    // success, fresh queued TaskFlow rows on failure), so the caller's finally
    // must not re-stage them a second time.
    params.postCompactionDelegatesToPreserve.length = 0;
  }

  // The delegates the claimed rows carried are now durable — delivered to the
  // session-delivery queue, persisted to the session store, or re-staged as
  // fresh queued TaskFlow rows above — so finish the claimed rows. Finalize ONLY
  // the rows THIS dispatch claimed, never other running rows for the session
  // (e.g. crash-orphaned ones awaiting recovery). A crash before this point
  // leaves the claimed rows recoverable via listRecoverableStagedPostCompactionDelegates
  // instead of silently losing them behind a premature finish (#1144).
  const flowIdsToFinalize = claimedFlowIds.filter(
    (flowId) => !flowId || !requeuedClaimedFlowIds.has(flowId),
  );
  const finalized = deps.finalizeStagedPostCompactionDelegates(flowIdsToFinalize);
  assertStagedPostCompactionFinalizationComplete({
    flowIds: flowIdsToFinalize,
    finalized,
    context: `queued post-compaction release for ${params.sessionKey}`,
  });

  const lifecycleEvent = buildPostCompactionLifecycleEvent({
    compactionCount: params.compactionCount,
    queuedDelegates: queuedEntryIds.length,
    droppedDelegates: droppedCompactionDelegates,
  });
  if (postCompactionContextContent) {
    // Trusted-internal producer: this is workspace AGENTS.md content read by
    // `readPostCompactionContext`, which may legitimately contain literal
    // `System:`/`[System]` strings (critical-rule examples, prompt scaffolding).
    // Mark it trusted so the inbound anti-spoof sanitizer preserves it verbatim
    // instead of rewriting those markers and corrupting the refresh context.
    deps.enqueueSystemEvent(postCompactionContextContent, {
      sessionKey: params.sessionKey,
      trusted: true,
    });
  }
  deps.enqueueSystemEvent(lifecycleEvent, {
    sessionKey: params.sessionKey,
    ...(internalReleaseTraceparent ? { traceparent: internalReleaseTraceparent } : {}),
  });

  if (queuedEntryIds.length > 0) {
    // Drain unfiltered for this sessionKey: the prior `entryIds`-filtered
    // drain stranded any failed `pending/` entries from earlier turns —
    // they were never re-selected because the filter excluded their ids,
    // and only startup recovery would rescue them. With `entryIds`
    // omitted, `selectEntry` falls back to the sessionKey filter and
    // backoff-eligible failed retries are reconsidered alongside the
    // entries we just enqueued.
    void deps
      .drainPostCompactionDelegateDeliveries({
        log: defaultRecoveryLog,
        sessionKey: params.sessionKey,
      })
      .catch((err: unknown) => {
        deps.log(
          `Failed to drain queued post-compaction delegates for ${params.sessionKey}: ${String(
            err,
          )}`,
        );
      });
  }

  return {
    queuedDelegates: queuedEntryIds.length,
    droppedDelegates: droppedCompactionDelegates,
  };
}
