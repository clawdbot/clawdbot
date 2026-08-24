import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { formatDelegateArtifactTaskInstruction } from "../../agents/delegate-artifact-policy.js";
import {
  assertDelegateArtifactPolicyPrepared,
  removeUnacceptedDelegateArtifactPolicy,
} from "../../agents/delegate-artifacts.js";
import { deriveContinuationDelegateChildSessionKey } from "../../agents/subagent-continuation-ids.js";
import {
  getSubagentRunByChildSessionKey,
  hasLiveContinuationDelegateChildRun,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import {
  spawnSubagentDirect,
  type SpawnSubagentContext,
  type SpawnSubagentParams,
} from "../../agents/subagents/spawn/subagent-spawn.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  resolveSessionEntryFromStore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry, SessionPostCompactionDelegate } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveContinuationTraceparent } from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import {
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
  type SessionDeliveryContext,
} from "../../infra/session-delivery-queue-storage.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveContinuationRuntimeConfig } from "../continuation/config.js";
import { registerContinuationDelegateDispatchClaim } from "../continuation/delegate-spawn-authority.js";
import {
  markPendingDelegateSpawnAccepted,
  revalidatePendingDelegateForSpawn,
  type DelegateSpawnFenceResult,
} from "../continuation/delegate-store.js";
import { reserveAcceptedPostCompactionChainHop } from "../continuation/post-compaction-chain-charge.js";
import {
  classifyPostCompactionDelegateAge,
  formatPostCompactionStaleRejection,
  POST_COMPACTION_DELEGATE_TTL_MS,
} from "../continuation/post-compaction-staleness.js";
import { failReleasedPostCompactionDelegate } from "../continuation/post-compaction-taskflow-rejection.js";
import { hasCrossSessionDelegateTargeting } from "../continuation/targeting-pure.js";
import type { ChainState, ContinuationRuntimeConfig } from "../continuation/types.js";

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
  patchSessionEntryCore: typeof patchSessionEntryCore;
  resolveContinuationRuntimeConfig(cfg: OpenClawConfig): ContinuationRuntimeConfig;
  resolveSessionAgentId(params: { sessionKey?: string; config?: OpenClawConfig }): string;
  resolveSessionStorePathCore(
    store?: string,
    opts?: { agentId?: string; env?: NodeJS.ProcessEnv },
  ): string;
  spawnSubagentDirect: PostCompactionDelegateSpawn;
  revalidatePendingDelegateForSpawn(
    delegate: { flowId?: string; expectedRevision?: number; task: string },
    controller: "post-compaction",
  ): DelegateSpawnFenceResult;
  markPendingDelegateSpawnAccepted(
    delegate: { flowId?: string; expectedRevision?: number; task: string },
    childSessionKey: string,
  ): boolean;
  failReleasedPostCompactionDelegate(
    delegate: { flowId?: string; expectedRevision?: number; task: string },
    blockedSummary: string,
    currentStep?: string,
  ): boolean;
  reserveAcceptedPostCompactionChainHop(
    delegate: { flowId?: string; expectedRevision?: number; task: string },
    plannedChainState: ChainState,
  ): { chainState: ChainState; expectedRevision: number | undefined };
};

const defaultPostCompactionDelegateDeliveryDeps: PostCompactionDelegateDeliveryDeps = {
  enqueueSystemEvent,
  getRuntimeConfig,
  loadSessionEntry,
  log: (message) => defaultRuntime.log(message),
  now: () => Date.now(),
  patchSessionEntryCore,
  resolveContinuationRuntimeConfig,
  resolveSessionAgentId,
  resolveSessionStorePathCore,
  spawnSubagentDirect,
  revalidatePendingDelegateForSpawn,
  markPendingDelegateSpawnAccepted,
  failReleasedPostCompactionDelegate,
  reserveAcceptedPostCompactionChainHop,
};

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
    ...(delegate.returnOptions ? { returnOptions: delegate.returnOptions } : {}),
    ...(delegate.recipientContext ? { recipientContext: delegate.recipientContext } : {}),
    ...(delegate.attachments ? { attachments: delegate.attachments } : {}),
    ...(delegate.attachAs ? { attachAs: delegate.attachAs } : {}),
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
  const persistedEntry = await patchSessionEntryCore(
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
  await patchSessionEntryCore(
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
  deps: Pick<PostCompactionDelegateDeliveryDeps, "failReleasedPostCompactionDelegate" | "log">,
  entry: QueuedPostCompactionDelegateDelivery,
  summary: string,
): void {
  if (!entry.sourceFlowId || entry.sourceExpectedRevision === undefined) {
    return;
  }
  const applied = deps.failReleasedPostCompactionDelegate(
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

/**
 * The continuation flow id this entry's child is spawned under. Source-backed
 * entries reuse their TaskFlow row id; a source-less entry falls back to the
 * queue entry id. The accepted-child replay guard MUST derive from the same
 * value the spawn does, or a retry after an accepted spawn re-spawns the child.
 */
function resolveQueuedPostCompactionContinuationFlowId(
  entry: QueuedPostCompactionDelegateDelivery,
): string {
  return entry.sourceFlowId ?? entry.id;
}

function resolveQueuedPostCompactionTraceparent(
  entry: QueuedPostCompactionDelegateDelivery,
): string | undefined {
  return entry.traceparentProvenance === "internal"
    ? resolveContinuationTraceparent(entry.traceparent)
    : undefined;
}

/**
 * Settle the parent chain charge for an accepted post-compaction child exactly once.
 *
 * `reserveAcceptedPostCompactionChainHop` writes the durable `advanced` marker on
 * the source row BEFORE this session-entry patch and returns that same hop on
 * every later call, so a replayed delivery re-persists the identical count rather
 * than advancing depth again. Charging here rather than before the spawn is what
 * keeps a retry that never reached an accepted child at zero continuation budget.
 */
async function commitAcceptedPostCompactionChainCharge(params: {
  deps: PostCompactionDelegateDeliveryDeps;
  entry: QueuedPostCompactionDelegateDelivery;
  plannedChainState: ChainState;
  sessionEntry?: SessionEntry;
  storePath: string;
}): Promise<{ expectedRevision: number | undefined }> {
  const { deps, entry, sessionEntry, storePath } = params;
  const reserved = deps.reserveAcceptedPostCompactionChainHop(
    {
      ...(entry.sourceFlowId ? { flowId: entry.sourceFlowId } : {}),
      ...(entry.sourceExpectedRevision !== undefined
        ? { expectedRevision: entry.sourceExpectedRevision }
        : {}),
      task: entry.task,
    },
    params.plannedChainState,
  );
  const { chainState } = reserved;
  let persistedEntry: SessionEntry | null;
  try {
    persistedEntry = await deps.patchSessionEntryCore(
      { storePath, sessionKey: entry.sessionKey },
      () => ({
        continuationChainCount: chainState.currentChainCount,
        continuationChainStartedAt: chainState.chainStartedAt,
        continuationChainTokens: chainState.accumulatedChainTokens,
        ...(chainState.chainId ? { continuationChainId: chainState.chainId } : {}),
      }),
      {
        ...(sessionEntry ? { fallbackEntry: sessionEntry } : {}),
        preserveActivity: true,
        requireWriteSuccess: true,
      },
    );
    if (!persistedEntry) {
      throw new Error(`session entry was not found: ${entry.sessionKey}`);
    }
  } catch (err) {
    deps.log(
      `Failed to persist post-compaction delegate chain state for ${entry.sessionKey}: ${String(err)}`,
    );
    // Rethrow so the delivery rejects, the queue entry stays in `pending/` with a
    // bumped retryCount, and the next unfiltered drain re-considers it once
    // backoff has elapsed. The child is already accepted here, so that retry is
    // caught by the accepted-child replay path below and reserves the same hop
    // instead of spawning a duplicate or charging a second time.
    throw err;
  }
  if (sessionEntry) {
    Object.assign(sessionEntry, persistedEntry);
  }
  return { expectedRevision: reserved.expectedRevision };
}

async function maybeFinalizePreviouslyAcceptedDelivery(params: {
  acceptedChildSessionKey: string;
  deps: PostCompactionDelegateDeliveryDeps;
  entry: QueuedPostCompactionDelegateDelivery;
  storePath: string;
}): Promise<boolean> {
  const { acceptedChildSessionKey, deps, entry, storePath } = params;
  if (
    !getSubagentRunByChildSessionKey(acceptedChildSessionKey) &&
    !hasLiveContinuationDelegateChildRun({
      childSessionKey: acceptedChildSessionKey,
      flowId: resolveQueuedPostCompactionContinuationFlowId(entry),
    })
  ) {
    return false;
  }
  if (entry.sourceFlowId && entry.sourceExpectedRevision !== undefined) {
    const sessionEntry = deps.loadSessionEntry({ storePath, sessionKey: entry.sessionKey });
    const { expectedRevision } = await commitAcceptedPostCompactionChainCharge({
      deps,
      entry,
      plannedChainState: {
        currentChainCount: (sessionEntry?.continuationChainCount ?? 0) + 1,
        chainStartedAt: sessionEntry?.continuationChainStartedAt ?? deps.now(),
        accumulatedChainTokens: sessionEntry?.continuationChainTokens ?? 0,
        chainId: sessionEntry?.continuationChainId ?? generateChainId(),
      },
      ...(sessionEntry ? { sessionEntry } : {}),
      storePath,
    });
    const committed = deps.markPendingDelegateSpawnAccepted(
      {
        flowId: entry.sourceFlowId,
        // The marker write leaves the row a revision past the queued claim, so
        // acceptance must commit against where the row actually is.
        expectedRevision: expectedRevision ?? entry.sourceExpectedRevision,
        task: entry.task,
      },
      acceptedChildSessionKey,
    );
    if (!committed) {
      throw new Error(
        `[continuation:post-compaction-source-accept-not-committed] flowId=${entry.sourceFlowId}`,
      );
    }
  }
  // A source-less entry has no TaskFlow row, so no durable marker can prove
  // whether the accepted hop was already charged. Re-charging here could double
  // count it, so the replay only reclaims the delivery: preventing a duplicate
  // spawn for a child that is already live is the load-bearing job.
  const entryTraceparent = resolveQueuedPostCompactionTraceparent(entry);
  deps.enqueueSystemEvent(
    `[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: ${entry.task}`,
    {
      sessionKey: entry.sessionKey,
      ...(entryTraceparent ? { traceparent: entryTraceparent } : {}),
    },
  );
  deps.log(
    `[continuation:post-compaction-source-accepted-recovered] flowId=${entry.sourceFlowId ?? entry.id} child=${acceptedChildSessionKey}`,
  );
  return true;
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
  const acceptedChildSessionKey = deriveContinuationDelegateChildSessionKey(
    agentId,
    resolveQueuedPostCompactionContinuationFlowId(params.entry),
  );
  const storePath = deps.resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const artifactMode = params.entry.returnOptions?.artifacts;
  const removeRejectedArtifactPolicy = (): void => {
    if (params.entry.sourceFlowId && (artifactMode === "optional" || artifactMode === "required")) {
      removeUnacceptedDelegateArtifactPolicy(params.entry.sourceFlowId);
    }
  };
  // An already-accepted child settles first and is never re-gated: its spawn is
  // live, so re-running policy or staleness here would strand a running child.
  if (
    await maybeFinalizePreviouslyAcceptedDelivery({
      acceptedChildSessionKey,
      deps,
      entry: params.entry,
      storePath,
    })
  ) {
    return;
  }
  // RFC §4.4 stale work dies before every other gate, including the disabled
  // deferral, so a released row cannot outlive the staged row it came from and
  // cannot be revived by a later retry, restart, or config flip. This must stay
  // ahead of the artifact-policy assert and the spawn so no attachment snapshot
  // is ever materialized for expired work.
  const staleness = classifyPostCompactionDelegateAge(params.entry, deps.now());
  if (staleness.stale) {
    // Diagnostics carry only the age: a stale drop must not spill task prose or
    // attachment bytes into logs, terminal rows, or queue diagnostics.
    deps.log(
      `[continuation:post-compaction-delivery-stale] entryId=${params.entry.id} flowId=${params.entry.sourceFlowId ?? "none"} ageMs=${staleness.ageMs} ttlMs=${POST_COMPACTION_DELEGATE_TTL_MS}`,
    );
    failSourceBackedPostCompactionDelivery(
      deps,
      params.entry,
      formatPostCompactionStaleRejection(staleness.ageMs),
    );
    removeRejectedArtifactPolicy();
    return;
  }
  const runtimeConfig = deps.resolveContinuationRuntimeConfig(cfg);
  if (!runtimeConfig.enabled) {
    throw new SessionDeliveryDeferredError(
      "post-compaction delegate delivery deferred while continuation is disabled",
    );
  }
  const sessionEntry = deps.loadSessionEntry({
    storePath,
    sessionKey: params.entry.sessionKey,
  });
  const {
    maxChainLength: maxCompactionChainLength,
    costCapTokens: compactionCostCapTokens,
    crossSessionTargeting,
  } = runtimeConfig;
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
    removeRejectedArtifactPolicy();
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
    removeRejectedArtifactPolicy();
    return;
  }

  if (
    crossSessionTargeting === "disabled" &&
    hasCrossSessionDelegateTargeting(params.entry, params.entry.sessionKey)
  ) {
    if (artifactMode === "optional" || artifactMode === "required") {
      throw new SessionDeliveryDeferredError(
        "post-compaction delegate delivery deferred while cross-session targeting is disabled",
      );
    }
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
  // Mint or reuse `continuationChainId` (UUID) so the post-compaction handoff
  // carries the same correlation key that
  // `agent-runner.ts:persistContinuationChainState` would have used before
  // compaction. A pre-compaction chain id survives the boundary; otherwise this
  // is the chain's first step post-handoff. It is resolved but NOT persisted
  // here: the child must be spawned with the id the accepted charge will record,
  // and an attempt that never reaches an accepted child persists nothing.
  const compactionChainId = sessionEntry?.continuationChainId ?? generateChainId();
  deps.log(
    `Post-compaction delegate dispatch for session ${params.entry.sessionKey}: ${params.entry.task}`,
  );
  const delegateWakeOnReturn = params.entry.silentWake ?? true;
  const delegateSilentAnnounce = params.entry.silent ?? delegateWakeOnReturn;

  const artifactFlowId = resolveQueuedPostCompactionContinuationFlowId(params.entry);
  if (artifactMode === "optional" || artifactMode === "required") {
    assertDelegateArtifactPolicyPrepared(artifactFlowId);
  }

  const activeDispatch = registerContinuationDelegateDispatchClaim({
    controller: "post-compaction",
    delegate: {
      flowId: params.entry.sourceFlowId,
      expectedRevision: params.entry.sourceExpectedRevision,
      task: params.entry.task,
    },
    loadOwnerSessionEntry: () =>
      deps.loadSessionEntry({ storePath, sessionKey: params.entry.sessionKey }),
    ownerSessionKey: params.entry.sessionKey,
  });
  try {
    const spawnFence = deps.revalidatePendingDelegateForSpawn(
      {
        flowId: params.entry.sourceFlowId,
        expectedRevision: params.entry.sourceExpectedRevision,
        task: params.entry.task,
      },
      "post-compaction",
    );
    if (!spawnFence.allowed) {
      removeRejectedArtifactPolicy();
      deps.log(
        `[continuation:post-compaction-spawn-fenced] reason=${spawnFence.reason} flowId=${params.entry.sourceFlowId ?? "unknown"} entryId=${params.entry.id}`,
      );
      throw new SessionDeliveryDeadLetteredError(spawnFence.summary);
    }

    const spawnResult = await deps.spawnSubagentDirect(
      {
        task:
          `[continuation:post-compaction] ` +
          `[continuation:chain-hop:${nextCompactionChainCount}] ` +
          `Compaction just completed. Carry this working state to the post-compaction session: ${params.entry.task}` +
          formatDelegateArtifactTaskInstruction(params.entry),
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
        continuationDelegateFlowId: resolveQueuedPostCompactionContinuationFlowId(params.entry),
        continuationChainState: {
          count: nextCompactionChainCount,
          startedAt: compactionChainStartedAt,
          tokens: compactionChainTokens,
          chainId: compactionChainId,
        },
        ...(params.entry.model ? { model: params.entry.model } : {}),
        ...(params.entry.attachments ? { attachments: params.entry.attachments } : {}),
        ...(params.entry.attachAs?.mountPath
          ? { attachMountPath: params.entry.attachAs.mountPath }
          : {}),
        ...(entryTraceparent ? { traceparent: entryTraceparent } : {}),
      },
      {
        agentSessionKey: params.entry.sessionKey,
        agentChannel: params.entry.deliveryContext?.channel,
        agentAccountId: params.entry.deliveryContext?.accountId,
        agentTo: params.entry.deliveryContext?.to,
        agentThreadId: params.entry.deliveryContext?.threadId,
        continuationDelegateAdmission: activeDispatch.authority,
      },
    );
    if (spawnResult.status === "cancelled") {
      removeRejectedArtifactPolicy();
      throw new SessionDeliveryDeadLetteredError(
        spawnResult.error ?? "Continuation delegate admission cancelled.",
      );
    }
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
        removeRejectedArtifactPolicy();
        return;
      }
      throw new Error(`post-compaction delegate spawn ${spawnResult.status}`);
    }
    // Charge the chain only now that a child is actually accepted. Everything
    // above this line — artifact policy, spawn fence, attachment materialization,
    // spawn rejection — leaves the persisted depth untouched, so a retry after any
    // of those failures still has its full budget.
    const { expectedRevision: acceptedRevision } = await commitAcceptedPostCompactionChainCharge({
      deps,
      entry: params.entry,
      plannedChainState: {
        currentChainCount: nextCompactionChainCount,
        chainStartedAt: compactionChainStartedAt,
        accumulatedChainTokens: compactionChainTokens,
        chainId: compactionChainId,
      },
      ...(sessionEntry ? { sessionEntry } : {}),
      storePath,
    });
    if (params.entry.sourceFlowId && params.entry.sourceExpectedRevision !== undefined) {
      const spawnedChildSessionKey = spawnResult.childSessionKey ?? acceptedChildSessionKey;
      const committed = deps.markPendingDelegateSpawnAccepted(
        {
          flowId: params.entry.sourceFlowId,
          expectedRevision: acceptedRevision ?? params.entry.sourceExpectedRevision,
          task: params.entry.task,
        },
        spawnedChildSessionKey,
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
  } finally {
    activeDispatch.release();
  }
}
