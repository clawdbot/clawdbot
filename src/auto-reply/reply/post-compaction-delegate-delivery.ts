import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { deriveContinuationDelegateChildSessionKey } from "../../agents/subagent-continuation-ids.js";
import {
  getSubagentRunByChildSessionKey,
  hasLiveContinuationDelegateChildRun,
} from "../../agents/subagent-registry-read.js";
import {
  spawnSubagentDirect,
  type SpawnSubagentContext,
  type SpawnSubagentParams,
} from "../../agents/subagent-spawn.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  patchSessionEntry,
  resolveSessionEntryFromStore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry, SessionPostCompactionDelegate } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveContinuationTraceparent } from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import type {
  QueuedSessionDelivery,
  SessionDeliveryContext,
} from "../../infra/session-delivery-queue-storage.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveContinuationRuntimeConfig } from "../continuation/config.js";
import {
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
} from "../continuation/delegate-store.js";
import { hasCrossSessionDelegateTargeting } from "../continuation/targeting-pure.js";
import type { ContinuationRuntimeConfig } from "../continuation/types.js";

export type QueuedPostCompactionDelegateDelivery = Extract<
  QueuedSessionDelivery,
  { kind: "postCompactionDelegate" }
>;

type PostCompactionDelegateSpawnResult = Awaited<ReturnType<typeof spawnSubagentDirect>>;

export type PostCompactionDelegateSpawn = (
  params: SpawnSubagentParams,
  context: SpawnSubagentContext,
) => Promise<PostCompactionDelegateSpawnResult>;

export type PostCompactionDelegateDeliveryDeps = {
  enqueueSystemEvent(
    text: string,
    options: { sessionKey: string; traceparent?: string; trusted?: boolean },
  ): void;
  getRuntimeConfig(): OpenClawConfig;
  loadSessionEntry(params: { storePath: string; sessionKey: string }): SessionEntry | undefined;
  log(message: string): void;
  now(): number;
  patchSessionEntry: typeof patchSessionEntry;
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

const defaultPostCompactionDelegateDeliveryDeps: PostCompactionDelegateDeliveryDeps = {
  enqueueSystemEvent,
  getRuntimeConfig,
  loadSessionEntry,
  log: (message) => defaultRuntime.log(message),
  now: () => Date.now(),
  patchSessionEntry,
  resolveContinuationRuntimeConfig,
  resolveSessionAgentId,
  resolveStorePath,
  spawnSubagentDirect,
  markPendingDelegateSpawnAccepted,
  markPendingDelegateFailed,
};

export const POST_COMPACTION_DELEGATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function syncPendingPostCompactionDelegates(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  delegates: SessionPostCompactionDelegate[] | undefined;
}) {
  if (params.sessionEntry) {
    params.sessionEntry.pendingPostCompactionDelegates = params.delegates;
  }
  if (params.sessionStore) {
    const resolved = resolveSessionEntryFromStore({
      store: params.sessionStore,
      sessionKey: params.sessionKey,
    });
    if (resolved.existing) {
      params.sessionStore[resolved.normalizedKey] = {
        ...resolved.existing,
        pendingPostCompactionDelegates: params.delegates,
      };
      for (const legacyKey of resolved.legacyKeys) {
        delete params.sessionStore[legacyKey];
      }
    }
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

export function formatPostCompactionDelegateTaskPreview(task: string): string {
  return JSON.stringify(task.length > 120 ? `${task.slice(0, 117)}...` : task);
}

export function resolvePostCompactionDelegateDeliveryContext(params: {
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
}): SessionDeliveryContext | undefined {
  const deliveryContext: SessionDeliveryContext = {
    ...(params.originatingChannel ? { channel: params.originatingChannel } : {}),
    ...(params.originatingTo ? { to: params.originatingTo } : {}),
    ...(params.originatingAccountId ? { accountId: params.originatingAccountId } : {}),
    ...(params.originatingThreadId != null ? { threadId: params.originatingThreadId } : {}),
  };
  return Object.keys(deliveryContext).length > 0 ? deliveryContext : undefined;
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

  const localStoredEntry = params.sessionStore
    ? resolveSessionEntryFromStore({
        store: params.sessionStore,
        sessionKey: params.sessionKey,
      }).existing
    : undefined;
  const fallbackEntry = localStoredEntry ?? params.sessionEntry;
  const persistedEntry = await patchSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    (current) => ({
      pendingPostCompactionDelegates: [
        ...(current.pendingPostCompactionDelegates ?? []).map(normalizePostCompactionDelegate),
        ...normalizedDelegates,
      ],
    }),
    {
      ...(fallbackEntry ? { fallbackEntry } : {}),
      preserveActivity: true,
      requireWriteSuccess: true,
    },
  );
  const persisted = (persistedEntry?.pendingPostCompactionDelegates ?? combinedLocal).map(
    normalizePostCompactionDelegate,
  );

  syncPendingPostCompactionDelegates({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    delegates: persisted,
  });
  return persisted;
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

  let persisted: SessionPostCompactionDelegate[] = [];
  await patchSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    (current) => {
      persisted = (current.pendingPostCompactionDelegates ?? []).map(
        normalizePostCompactionDelegate,
      );
      return persisted.length > 0 ? { pendingPostCompactionDelegates: undefined } : null;
    },
    { preserveActivity: true, requireWriteSuccess: true },
  );

  syncPendingPostCompactionDelegates({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    delegates: undefined,
  });
  return persisted.length > 0 ? persisted : localDelegates;
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

function resolveQueuedPostCompactionTraceparent(
  entry: QueuedPostCompactionDelegateDelivery,
): string | undefined {
  return entry.traceparentProvenance === "internal"
    ? resolveContinuationTraceparent(entry.traceparent)
    : undefined;
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
  patchSessionEntry: typeof patchSessionEntry;
  sessionEntry?: SessionEntry;
  sessionKey: string;
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
  let persistedEntry: SessionEntry | null = null;
  if (params.storePath) {
    try {
      persistedEntry = await params.patchSessionEntry(
        { storePath: params.storePath, sessionKey: params.sessionKey },
        () => ({
          continuationChainCount: params.count,
          continuationChainStartedAt: params.startedAt,
          continuationChainTokens: params.tokens,
          continuationChainId: chainId,
        }),
        {
          ...(params.sessionEntry ? { fallbackEntry: params.sessionEntry } : {}),
          preserveActivity: true,
          requireWriteSuccess: true,
        },
      );
      if (!persistedEntry) {
        throw new Error(`session entry was not found: ${params.sessionKey}`);
      }
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
  if (params.sessionEntry) {
    Object.assign(
      params.sessionEntry,
      persistedEntry ?? {
        continuationChainCount: params.count,
        continuationChainStartedAt: params.startedAt,
        continuationChainTokens: params.tokens,
        continuationChainId: chainId,
      },
    );
  }
  return { chainId };
}

export function isQueuedPostCompactionDelegateDelivery(
  entry: QueuedSessionDelivery,
): entry is QueuedPostCompactionDelegateDelivery {
  return entry.kind === "postCompactionDelegate";
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
  const sessionEntry = deps.loadSessionEntry({
    storePath,
    sessionKey: params.entry.sessionKey,
  });
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
    patchSessionEntry: deps.patchSessionEntry,
    sessionEntry,
    sessionKey: params.entry.sessionKey,
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
