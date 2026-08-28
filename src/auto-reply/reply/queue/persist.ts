import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../../config/io.js";
import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  hasFollowupQueueEntries,
  listUnreadableFollowupQueueKeys,
  loadFollowupQueueEntries,
  replaceFollowupQueueEntries,
} from "../../../infra/followup-queue-sqlite.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  resolveGlobalMap,
  resolveGlobalSet,
  resolveGlobalSingleton,
} from "../../../shared/global-singleton.js";
import { normalizeQueueDropPolicy, normalizeQueueMode } from "./normalize.js";
import {
  isExpiredPersistedFollowup,
  persistedFollowupCarriesInlineImagePayload,
} from "./persist-codec-policy.js";
import {
  createExplicitSkillRestoreResolver,
  describeFollowupForLog,
  hasInvalidExplicitSkillSelections,
  hasInvalidInputProvenance,
  hasInvalidRestrictiveExecOverrides,
  hasInvalidScheduledToolPolicy,
  hasInvalidSessionPermissionPolicy,
  hasInvalidSkillWorkshopProposalRevision,
  hasInvalidTerminalReplyExpectation,
  hasInvalidToolsAllowIntersection,
  isCanceledPersistedFollowup,
  isDelegatedAuthorityPersistedFollowup,
  isDeliveredPersistedFollowup,
  isDiscardedPersistedFollowup,
  isPersistedQueueEntry,
  isPersistedRunFields,
  isRoleDependentPersistedFollowup,
  persistedFollowupItemCarriesInboundContext,
  persistedInputProvenanceCarriesSourceIdentity,
  persistedRunCarriesRawChannelIdentity,
  rehydratePersistedFollowupRun,
  rehydrateRun,
  toPersistedQueueEntry,
  type ExplicitSkillRestoreResolution,
  type PersistedFollowupRun,
  type PersistedQueueEntry,
  type RestoredExplicitSkillSelections,
} from "./persist-codec.js";
import type { FollowupQueueState, FollowupRun, QueueDropPolicy } from "./types.js";

const DEFAULT_QUEUE_DEBOUNCE_MS = 500;
const DEFAULT_QUEUE_CAP = 20;
const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(
  Symbol.for("openclaw.followupQueues"),
);

/**
 * Keys of non-empty queues restored from disk on this process start.
 * Entries are removed when kickFollowupDrainIfIdle runs for the route.
 * Production drains restored items after restart when agent-runner enqueues
 * with restartIfIdle=true, or when gateway startup wakes the session.
 *
 * Must be process-wide: restoreFollowupQueues() can run from a bundled copy
 * of this module while Gateway recovery and agent-runner drain mapping run
 * from another copy. A module-local Set would leave those copies empty after
 * the restore-once flag is set.
 */
const restoredPendingDrainKeys = resolveGlobalSet<string>(
  Symbol.for("openclaw.followupQueueRestoredPendingDrainKeys"),
  "close-and-restart",
);

export function peekRestoredPendingDrainKeys(): ReadonlySet<string> {
  return restoredPendingDrainKeys;
}

export function clearRestoredPendingDrainKey(key: string): void {
  restoredPendingDrainKeys.delete(key);
}

/**
 * Map a heartbeat/reply session key back to a restored follow-up queue key.
 * Isolated heartbeats run under `<base>:heartbeat` while the durable queue
 * remains keyed by `<base>`; strip synthetic `:heartbeat` suffixes until a
 * pending restore key matches.
 */
export function resolveRestoredFollowupQueueRecoveryKey(
  candidates: Array<string | undefined | null>,
): string | undefined {
  if (restoredPendingDrainKeys.size === 0) {
    return undefined;
  }
  for (const raw of candidates) {
    const key = raw?.trim();
    if (key && restoredPendingDrainKeys.has(key)) {
      return key;
    }
  }
  for (const raw of candidates) {
    let cursor = raw?.trim();
    if (!cursor) {
      continue;
    }
    while (cursor.endsWith(":heartbeat")) {
      cursor = cursor.slice(0, -":heartbeat".length);
      if (!cursor) {
        break;
      }
      if (restoredPendingDrainKeys.has(cursor)) {
        return cursor;
      }
    }
  }
  return undefined;
}

/** For testing only — reset the pending-drain set between test cases. */
export function clearRestoredPendingDrainKeysForTest(): void {
  restoredPendingDrainKeys.clear();
}

// Process-wide restore-once flag. restoreFollowupQueues() is called at module
// evaluation; in a bundled/split-runtime layout multiple copies of state.ts can
// evaluate, each calling restore. Without a guard, a second restore could
// overwrite an in-flight FOLLOWUP_QUEUES entry (already draining or carrying a
// newer enqueue), causing replay of an already-delivered prompt or loss of a
// fresh queued item. The flag is set only after SQLite initialization succeeds;
// a transient open/schema failure retries instead of stranding queued work.
// Symbol.for is used directly on globalThis (not via resolveGlobalSingleton) so
// the flag is shared by reference across split runtime chunks — see the note in
// src/shared/global-singleton.ts.
const FOLLOWUP_QUEUES_RESTORED_KEY = Symbol.for("openclaw.followupQueuesRestored");
type FollowupQueuesGlobal = { [FOLLOWUP_QUEUES_RESTORED_KEY]?: boolean };

const MAX_FOLLOWUP_QUEUE_RESTORE_RETRIES = 5;

type FollowupQueueRestoreCoordination = {
  inFlight: boolean;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  listener: (() => void) | undefined;
};

// Restore coordination must share the same process slot as the pending-key
// registry. A second bundled copy that sees the restore-once flag still has
// to observe in-flight retries and the Gateway recovery listener.
const restoreCoordination = resolveGlobalSingleton<FollowupQueueRestoreCoordination>(
  Symbol.for("openclaw.followupQueueRestoreCoordination"),
  () => ({
    inFlight: false,
    retryCount: 0,
    retryTimer: undefined,
    listener: undefined,
  }),
);

/**
 * Gateway recovery registers a listener so a restore that succeeds after the
 * one-shot startup wake still drains pending sessions.
 */
export function setRestoredFollowupQueuesListener(listener: (() => void) | undefined): void {
  restoreCoordination.listener = listener;
}

/** Drop the restore listener only when it is still the caller’s callback. */
export function unsetRestoredFollowupQueuesListener(listener: () => void): void {
  if (restoreCoordination.listener === listener) {
    restoreCoordination.listener = undefined;
  }
}

function notifyRestoredFollowupQueuesIfPending(): void {
  if (restoredPendingDrainKeys.size === 0) {
    return;
  }
  restoreCoordination.listener?.();
}

function followupQueuesGlobal(): FollowupQueuesGlobal {
  // SAFETY: this process-wide Symbol.for key stores only the optional restore-once boolean.
  return globalThis as FollowupQueuesGlobal;
}

function hasFollowupQueuesRestored(): boolean {
  return followupQueuesGlobal()[FOLLOWUP_QUEUES_RESTORED_KEY] === true;
}

function markFollowupQueuesRestored(): void {
  followupQueuesGlobal()[FOLLOWUP_QUEUES_RESTORED_KEY] = true;
}

function unmarkFollowupQueuesRestored(): void {
  delete followupQueuesGlobal()[FOLLOWUP_QUEUES_RESTORED_KEY];
}

function clearFollowupQueueRestoreRetryTimer(): void {
  if (restoreCoordination.retryTimer !== undefined) {
    clearTimeout(restoreCoordination.retryTimer);
    restoreCoordination.retryTimer = undefined;
  }
}

function scheduleFollowupQueueRestoreRetry(): void {
  if (restoreCoordination.retryCount >= MAX_FOLLOWUP_QUEUE_RESTORE_RETRIES) {
    return;
  }
  restoreCoordination.retryCount += 1;
  clearFollowupQueueRestoreRetryTimer();
  const delayMs = 100 * restoreCoordination.retryCount;
  restoreCoordination.retryTimer = setTimeout(() => {
    restoreCoordination.retryTimer = undefined;
    restoreFollowupQueues();
  }, delayMs);
}

/** For testing only — reset the restore-once flag between test cases. */
export function clearFollowupQueuesRestoredFlagForTest(): void {
  unmarkFollowupQueuesRestored();
  restoreCoordination.inFlight = false;
  restoreCoordination.retryCount = 0;
  clearFollowupQueueRestoreRetryTimer();
}

/** For tests: whether any followup queue rows exist in shared SQLite state. */
export function hasPersistedFollowupQueues(stateDir?: string): boolean {
  return hasFollowupQueueEntries(stateDir);
}

// Resolve the current process config for restored runs. Prefer the live runtime
// snapshot (set by the agent runtime layer) so callers never pay disk IO. If
// the snapshot is not yet populated — e.g. restore runs before
// setRuntimeConfigSnapshot has been called during cold start — fall back to
// getRuntimeConfig() so restored followups dispatch with the current
// provider/channel/auth state rather than an empty stub. restoreFollowupQueues
// runs once at module init from a single point on the gateway boundary, so the
// getRuntimeConfig() fallback is a bounded process-boundary call (not an
// ambient hot-path lookup). If both paths fail, log and return an empty config;
// the dispatcher's resolveQueuedReplyExecutionConfig still has another chance
// to fill it from the runtime snapshot before the run is consumed.
function emptyRestoreConfig(): OpenClawConfig {
  // SAFETY: empty config fail-open; dispatch re-reads the live snapshot.
  return {} as OpenClawConfig;
}

function resolveCurrentRunConfig(): OpenClawConfig {
  const snapshot = getRuntimeConfigSnapshot();
  if (snapshot) {
    return snapshot;
  }
  try {
    return getRuntimeConfig();
  } catch (err) {
    defaultRuntime.error?.(
      `failed to load current config for followup queue restore: ${String(err)}`,
    );
    return emptyRestoreConfig();
  }
}

type RestoreFailCloseGuard = {
  blocks: (
    item: PersistedFollowupRun,
    resolveExplicitSkillSelections: (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution,
  ) => boolean;
  reason: string;
};

/**
 * Restore fail-close guards, evaluated in order. Pairing each predicate with
 * its log reason keeps the block decision and the operator-facing message from
 * drifting apart.
 */
const RESTORE_FAIL_CLOSE_GUARDS: readonly RestoreFailCloseGuard[] = [
  {
    blocks: (item) => isRoleDependentPersistedFollowup(item),
    reason: "role-dependent work cannot revalidate member roles after restart",
  },
  {
    blocks: (item) => isDelegatedAuthorityPersistedFollowup(item),
    reason: "delegated handoff or plugin tool grant cannot be revalidated after restart",
  },
  {
    blocks: (item) => isCanceledPersistedFollowup(item),
    reason: "canceled work cannot execute after restart",
  },
  {
    blocks: (item) => isDeliveredPersistedFollowup(item),
    reason: "already-delivered work cannot replay after restart",
  },
  {
    blocks: (item) => isDiscardedPersistedFollowup(item),
    reason: "undelivered completed work cannot replay after restart",
  },
  {
    blocks: (item) => persistedFollowupCarriesInlineImagePayload(item),
    reason: "inline image payloads are never retained across restarts",
  },
  {
    blocks: (item) => isExpiredPersistedFollowup(item),
    reason: "queued work exceeded the bounded retention window",
  },
  {
    blocks: (item) => hasInvalidScheduledToolPolicy(item.run),
    reason: "scheduled tool policy is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidSessionPermissionPolicy(item.run),
    reason: "session permission policy is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidRestrictiveExecOverrides(item.run),
    reason: "exec override policy is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidSkillWorkshopProposalRevision(item.run),
    reason: "Skill Workshop revision constraint is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidTerminalReplyExpectation(item.run),
    reason: "terminal reply expectation is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidInputProvenance(item.run),
    reason: "input provenance is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidToolsAllowIntersection(item),
    reason: "tool allowlist intersection cannot restore without toolsAllow",
  },
  {
    blocks: (item, resolve) => hasInvalidExplicitSkillSelections(item, resolve),
    reason: "explicit skill selections are missing or invalid after restart",
  },
];

function findRestoreFailCloseReason(
  item: PersistedFollowupRun,
  resolveExplicitSkillSelections: (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution,
): string | undefined {
  return RESTORE_FAIL_CLOSE_GUARDS.find((guard) =>
    guard.blocks(item, resolveExplicitSkillSelections),
  )?.reason;
}

function isUnrestorablePersistedFollowup(
  item: PersistedFollowupRun,
  resolveExplicitSkillSelections: (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution,
): boolean {
  return findRestoreFailCloseReason(item, resolveExplicitSkillSelections) !== undefined;
}

function failClosedUnrestorablePersistedFollowup(
  queueKey: string,
  item: PersistedFollowupRun,
  resolveExplicitSkillSelections: (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution,
): boolean {
  const reason = findRestoreFailCloseReason(item, resolveExplicitSkillSelections);
  if (reason === undefined) {
    return false;
  }
  defaultRuntime.error?.(
    `fail-closed restored followup for ${queueKey}: ${reason} (${describeFollowupForLog(item)})`,
  );
  return true;
}

function rehydrateRestorablePersistedFollowups(
  queueKey: string,
  items: readonly PersistedFollowupRun[],
  currentConfig: OpenClawConfig,
  pairedLines?: readonly string[],
  resolveExplicitSkillSelections: (
    item: PersistedFollowupRun,
  ) => ExplicitSkillRestoreResolution = createExplicitSkillRestoreResolver(currentConfig),
): { restored: FollowupRun[]; restoredLines: string[]; skippedUnrestorable: boolean } {
  const candidates: Array<{
    item: PersistedFollowupRun;
    line?: string;
    explicitSkillSelections?: RestoredExplicitSkillSelections;
  }> = [];
  let skippedUnrestorable = false;
  if (pairedLines !== undefined && pairedLines.length !== items.length) {
    skippedUnrestorable = true;
  }
  const limit =
    pairedLines === undefined ? items.length : Math.min(items.length, pairedLines.length);
  for (let index = 0; index < limit; index += 1) {
    const item = items[index]!;
    if (failClosedUnrestorablePersistedFollowup(queueKey, item, resolveExplicitSkillSelections)) {
      skippedUnrestorable = true;
      continue;
    }
    const explicitSkillSelections = resolveExplicitSkillSelections(item);
    candidates.push({
      item,
      line: pairedLines?.[index],
      ...(explicitSkillSelections.status === "ok"
        ? { explicitSkillSelections: explicitSkillSelections.selections }
        : {}),
    });
  }
  for (let index = limit; index < items.length; index += 1) {
    skippedUnrestorable = true;
    failClosedUnrestorablePersistedFollowup(
      queueKey,
      items[index]!,
      resolveExplicitSkillSelections,
    );
  }

  const restored: FollowupRun[] = [];
  const restoredLines: string[] = [];
  for (const candidate of candidates) {
    const [kept] = filterRestorableFollowupItems(queueKey, [
      rehydratePersistedFollowupRun(
        candidate.item,
        currentConfig,
        candidate.explicitSkillSelections,
      ),
    ]);
    if (!kept) {
      skippedUnrestorable = true;
      continue;
    }
    restored.push(kept);
    if (candidate.line !== undefined) {
      restoredLines.push(candidate.line);
    }
  }
  return { restored, restoredLines, skippedUnrestorable };
}

function filterRestorableFollowupItems(queueKey: string, items: FollowupRun[]): FollowupRun[] {
  const restored: FollowupRun[] = [];
  for (const item of items) {
    const sessionKey = normalizeOptionalString(item.run.sessionKey);
    if (sessionKey && sessionKey !== queueKey && !queueKey.startsWith(`${sessionKey}:`)) {
      defaultRuntime.error?.(
        `skipping restored followup for ${queueKey}: sessionKey ${sessionKey} does not match queue key`,
      );
      continue;
    }
    const channel = normalizeOptionalString(item.originatingChannel);
    const to = normalizeOptionalString(item.originatingTo);
    if ((channel && !to) || (!channel && to)) {
      defaultRuntime.error?.(
        `skipping restored followup for ${queueKey}: incomplete originating route (${channel ?? "?"} -> ${to ?? "?"})`,
      );
      continue;
    }
    restored.push(item);
  }
  return restored;
}

function isDeliverablePersistedFollowup(
  queueKey: string,
  item: PersistedFollowupRun,
  resolveExplicitSkillSelections: (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution,
): boolean {
  const sessionKey = normalizeOptionalString(item.run.sessionKey);
  if (sessionKey && sessionKey !== queueKey && !queueKey.startsWith(`${sessionKey}:`)) {
    return false;
  }
  const channel = normalizeOptionalString(item.originatingChannel);
  const to = normalizeOptionalString(item.originatingTo);
  if ((channel && !to) || (!channel && to)) {
    return false;
  }
  return !isUnrestorablePersistedFollowup(item, resolveExplicitSkillSelections);
}

/**
 * True when this persisted entry would restore without skipping any
 * delivery-bearing source (items, overflow summarySources, or elision sources)
 * and without leaving overflow that the normal drain cannot deliver.
 *
 * Drain only sends overflow summaries when `droppedCount > 0`. A stored queue
 * that keeps summary sources/lines/elisions at `droppedCount === 0` would
 * never emit those summaries after restore.
 */
export function canMigrateFollowupQueueEntryLosslessly(
  queueKey: string,
  value: unknown,
): value is PersistedQueueEntry {
  if (!isPersistedQueueEntry(value)) {
    return false;
  }
  for (const elision of value.summaryElisions ?? []) {
    if (
      elision.count !== elision.sources.length ||
      elision.sources.length !== elision.summaryLines.length
    ) {
      return false;
    }
  }
  const summarySources = value.summarySources ?? [];
  const summaryLines = value.summaryLines ?? [];
  const elisions = value.summaryElisions ?? [];
  const elisionSourceCount = elisions.reduce((sum, elision) => sum + elision.sources.length, 0);
  const hasOverflowPayload =
    summarySources.length > 0 || elisions.length > 0 || summaryLines.length > 0;
  if (hasOverflowPayload && value.droppedCount <= 0) {
    return false;
  }
  if (summarySources.length !== summaryLines.length) {
    return false;
  }
  if (value.droppedCount < summarySources.length + elisionSourceCount) {
    return false;
  }
  const elisionSources = elisions.flatMap((elision) => elision.sources);
  const resolveExplicitSkillSelections =
    createExplicitSkillRestoreResolver(resolveCurrentRunConfig());
  return [...value.items, ...summarySources, ...elisionSources].every((item) =>
    isDeliverablePersistedFollowup(queueKey, item, resolveExplicitSkillSelections),
  );
}
/**
 * Bind restored work to the fresh queue abort controller so `clearFollowupQueue`
 * can cancel restarted items and overflow sources through the normal drain path.
 */
function bindRestoredRunsToQueueAbort(queue: FollowupQueueState): void {
  const signal = queue.abortController.signal;
  for (const item of queue.items) {
    item.queueAbortSignal = signal;
  }
  for (const source of queue.summarySources) {
    source.queueAbortSignal = signal;
  }
  for (const elision of queue.summaryElisions) {
    for (const source of elision.sources) {
      source.queueAbortSignal = signal;
    }
  }
}

/**
 * Write all non-empty followup queues to disk so they survive gateway restarts.
 * Called after any mutation that changes queue contents (enqueue, drain, clear).
 *
 * Rows stay in SQLite until delivery settles (successful channel handoff or
 * fail-closed discard). In-flight marks are process-local only.
 */
function persistedQueueEntryRuns(data: PersistedQueueEntry): PersistedFollowupRun["run"][] {
  return [
    ...data.items.map((item) => item.run),
    ...(data.summarySources ?? []).map((item) => item.run),
    ...(data.summaryElisions ?? []).flatMap((elision) =>
      elision.sources.map((source) => source.run),
    ),
    ...(data.lastRun ? [data.lastRun] : []),
  ];
}

function persistedQueueEntryCarriesRawInputProvenance(data: PersistedQueueEntry): boolean {
  return persistedQueueEntryRuns(data).some(persistedInputProvenanceCarriesSourceIdentity);
}

function persistedQueueEntryCarriesRawChannelIdentity(data: PersistedQueueEntry): boolean {
  return persistedQueueEntryRuns(data).some(persistedRunCarriesRawChannelIdentity);
}

function persistedQueueEntryCarriesInboundContext(data: PersistedQueueEntry): boolean {
  return [
    ...data.items,
    ...(data.summarySources ?? []),
    ...(data.summaryElisions ?? []).flatMap((elision) => elision.sources),
  ].some(persistedFollowupItemCarriesInboundContext);
}

export function persistFollowupQueuesOrThrow(): void {
  const entries: Array<[string, PersistedQueueEntry]> = [];
  for (const [key, queue] of FOLLOWUP_QUEUES) {
    if (!queue || (queue.items.length === 0 && queue.droppedCount === 0)) {
      continue;
    }
    entries.push([key, toPersistedQueueEntry(queue)]);
  }
  replaceFollowupQueueEntries({
    entries,
    retainKeys: listUnreadableFollowupQueueKeys(),
  });
}

/**
 * Best-effort persist for non-critical callers (enqueue). Drain settlement uses
 * {@link persistFollowupQueuesOrThrow} so ack failures fail closed.
 */
export function persistFollowupQueues(): void {
  try {
    persistFollowupQueuesOrThrow();
  } catch (err) {
    defaultRuntime.error?.(`failed to persist followup queues: ${String(err)}`);
  }
}

/**
 * Read persisted queue state from disk and populate FOLLOWUP_QUEUES.
 * Called once at module init, before any queue operations.
 */
export function restoreFollowupQueues(): void {
  // Restore exactly once per process after SQLite initialization succeeds.
  // A concurrent call from a second module evaluation must not replay restore
  // over an in-flight FOLLOWUP_QUEUES entry. If the first SQLite/schema access
  // fails transiently, leave the flag unset and retry so queued work is not
  // stranded until a manual restart.
  if (hasFollowupQueuesRestored() || restoreCoordination.inFlight) {
    return;
  }
  restoreCoordination.inFlight = true;
  let entries: Array<[string, unknown]>;
  try {
    entries = loadFollowupQueueEntries();
  } catch (err) {
    restoreCoordination.inFlight = false;
    defaultRuntime.error?.(`failed to restore followup queues: ${String(err)}`);
    scheduleFollowupQueueRestoreRetry();
    return;
  }
  markFollowupQueuesRestored();
  restoreCoordination.inFlight = false;
  restoreCoordination.retryCount = 0;
  try {
    if (entries.length === 0) {
      notifyRestoredFollowupQueuesIfPending();
      return;
    }
    const currentConfig = resolveCurrentRunConfig();
    const resolveExplicitSkillSelections = createExplicitSkillRestoreResolver(currentConfig);
    let skippedUnrestorable = false;
    let sanitizedClosedDescriptor = false;
    for (const entry of entries) {
      const key = normalizeOptionalString(Array.isArray(entry) ? entry[0] : undefined);
      const rawData = Array.isArray(entry) ? entry[1] : undefined;
      if (!key || !isPersistedQueueEntry(rawData)) {
        continue;
      }
      const data = rawData;
      sanitizedClosedDescriptor ||= persistedQueueEntryCarriesRawInputProvenance(data);
      sanitizedClosedDescriptor ||= persistedQueueEntryCarriesRawChannelIdentity(data);
      sanitizedClosedDescriptor ||= persistedQueueEntryCarriesInboundContext(data);
      const itemsRestore = rehydrateRestorablePersistedFollowups(
        key,
        data.items,
        currentConfig,
        undefined,
        resolveExplicitSkillSelections,
      );
      skippedUnrestorable ||= itemsRestore.skippedUnrestorable;
      const rehydratedItems = itemsRestore.restored;
      const originalSummarySources = data.summarySources ?? [];
      const originalSummaryLines = Array.isArray(data.summaryLines) ? data.summaryLines : [];
      const summaryRestore = rehydrateRestorablePersistedFollowups(
        key,
        originalSummarySources,
        currentConfig,
        originalSummaryLines,
        resolveExplicitSkillSelections,
      );
      skippedUnrestorable ||= summaryRestore.skippedUnrestorable;
      const rehydratedSummarySources = summaryRestore.restored;
      let removedOverflowCount = originalSummarySources.length - rehydratedSummarySources.length;
      const restoredElisions = (data.summaryElisions ?? []).flatMap((elision) => {
        let droppedElision = false;
        for (const source of elision.sources) {
          if (
            failClosedUnrestorablePersistedFollowup(key, source, resolveExplicitSkillSelections)
          ) {
            skippedUnrestorable = true;
            droppedElision = true;
          }
        }
        if (droppedElision) {
          removedOverflowCount += elision.sources.length;
          return [];
        }
        const sources = filterRestorableFollowupItems(
          key,
          elision.sources.map((persisted) => {
            const resolved = resolveExplicitSkillSelections(persisted);
            return rehydratePersistedFollowupRun(
              persisted,
              currentConfig,
              resolved.status === "ok" ? resolved.selections : undefined,
            );
          }),
        );
        if (sources.length === 0 || sources.length !== elision.sources.length) {
          skippedUnrestorable = true;
          removedOverflowCount += elision.sources.length;
          return [];
        }
        return [
          {
            contextKey: elision.contextKey,
            count: elision.count,
            sources,
            summaryLines: [...elision.summaryLines],
            sourceRefs: new WeakMap(),
          },
        ];
      });
      const hasSummaryPayload = rehydratedSummarySources.length > 0 || restoredElisions.length > 0;
      if (rehydratedItems.length === 0 && !hasSummaryPayload) {
        continue;
      }
      const originalDroppedCount =
        typeof data.droppedCount === "number" ? Math.max(0, Math.floor(data.droppedCount)) : 0;
      const restoredDroppedCount = hasSummaryPayload
        ? Math.max(0, originalDroppedCount - removedOverflowCount)
        : 0;
      const restored: FollowupQueueState = {
        abortController: new AbortController(),
        items: rehydratedItems,
        draining: false,
        inFlight: new Set(),
        lastEnqueuedAt: typeof data.lastEnqueuedAt === "number" ? data.lastEnqueuedAt : Date.now(),
        mode: normalizeQueueMode(data.mode) ?? "steer",
        debounceMs:
          typeof data.debounceMs === "number"
            ? Math.max(0, data.debounceMs)
            : DEFAULT_QUEUE_DEBOUNCE_MS,
        cap:
          typeof data.cap === "number" && data.cap > 0 ? Math.floor(data.cap) : DEFAULT_QUEUE_CAP,
        dropPolicy: normalizeQueueDropPolicy(data.dropPolicy) ?? DEFAULT_QUEUE_DROP,
        droppedCount: restoredDroppedCount,
        summaryLines: hasSummaryPayload ? summaryRestore.restoredLines : [],
        summarySources: rehydratedSummarySources,
        steerAcceptanceTail: Promise.resolve(true),
        activeSummarySources: new WeakSet(),
        summaryElisions: restoredElisions,
        evictedSummaryCount:
          typeof data.evictedSummaryCount === "number"
            ? Math.max(0, Math.floor(data.evictedSummaryCount))
            : 0,
        ...(isPersistedRunFields(data.lastRun)
          ? { lastRun: rehydrateRun(data.lastRun, currentConfig) }
          : {}),
      };
      bindRestoredRunsToQueueAbort(restored);
      FOLLOWUP_QUEUES.set(key, restored);
      const hasPendingRestoredWork =
        restored.items.length > 0 ||
        restored.droppedCount > 0 ||
        restored.summarySources.length > 0;
      if (hasPendingRestoredWork) {
        restoredPendingDrainKeys.add(key);
      }
    }
    if (skippedUnrestorable || sanitizedClosedDescriptor) {
      // Durable non-delivery: drop fail-closed rows, and rewrite descriptors
      // that still carried raw source-session provenance, sender/channel
      // identities, or current-turn inbound prompt context so restart cannot
      // revive those requester-policy inputs.
      persistFollowupQueuesOrThrow();
    }
  } catch (err) {
    defaultRuntime.error?.(`failed to restore followup queues: ${String(err)}`);
  }
  notifyRestoredFollowupQueuesIfPending();
}
