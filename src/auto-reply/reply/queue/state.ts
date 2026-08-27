// Tracks queue state for active, pending, and recently deduped reply runs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelFallbackRouteResolution } from "../../../agents/model-fallback.types.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { applyQueueRuntimeSettings } from "../../../utils/queue-helpers.js";
import {
  normalizeThinkLevel,
  resolveSupportedThinkingLevel,
  resolveThinkingDefaultForModel,
  type ThinkingCatalogEntry,
} from "../../thinking.js";
import { persistFollowupQueuesOrThrow, restoreFollowupQueues } from "./persist.js";
import {
  completeFollowupRunLifecycle,
  type FollowupQueueState,
  type FollowupRun,
  type QueueDropPolicy,
  type QueueSettings,
} from "./types.js";

export const DEFAULT_QUEUE_DEBOUNCE_MS = 500;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

/**
 * Share followup queues across bundled chunks so busy-session enqueue/drain
 * logic observes one queue registry per process.
 */
const FOLLOWUP_QUEUES_KEY = Symbol.for("openclaw.followupQueues");

export const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(FOLLOWUP_QUEUES_KEY);

export function getExistingFollowupQueue(key: string): FollowupQueueState | undefined {
  const cleaned = key.trim();
  if (!cleaned) {
    return undefined;
  }
  const queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) {
    return undefined;
  }
  ensureFollowupQueueSummaryState(queue);
  return queue;
}

function ensureFollowupQueueSummaryState(queue: FollowupQueueState): void {
  queue.summarySources ??= [];
  queue.summaryElisions ??= [];
  queue.evictedSummaryCount ??= 0;
  queue.steerAcceptanceTail ??= Promise.resolve(true);
}

export function hasPendingFollowupQueueWork(keys: Iterable<string | undefined>): boolean {
  const seen = new Set<string>();
  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    const queue = getExistingFollowupQueue(cleaned);
    if (queue && (queue.items.length > 0 || queue.inFlight.size > 0 || queue.droppedCount > 0)) {
      return true;
    }
  }
  return false;
}

type SummaryElisionCapState = Pick<
  FollowupQueueState,
  "activeSummarySources" | "cap" | "evictedSummaryCount" | "summaryElisions"
>;

/**
 * Trim overflow summary-elision sources down to the queue cap.
 *
 * By default, completes the lifecycle of each evicted source. Pass
 * `deferLifecycleCompletion: true` when the caller needs atomic rollback across a
 * later durable write — evicted sources are returned instead of completed.
 */
export function trimSummaryElisionsToCap(
  queue: SummaryElisionCapState,
  options?: { deferLifecycleCompletion?: boolean },
): FollowupRun[] {
  const deferredCompletions: FollowupRun[] = [];
  let sourceCount = queue.summaryElisions.reduce(
    (count, entry) =>
      count + entry.sources.filter((source) => !queue.activeSummarySources.has(source)).length,
    0,
  );
  while (sourceCount > queue.cap) {
    let evicted = false;
    for (const [entryIndex, entry] of queue.summaryElisions.entries()) {
      const sourceIndex = entry.sources.findIndex(
        (source) => !queue.activeSummarySources.has(source),
      );
      if (sourceIndex < 0) {
        continue;
      }
      const [source] = entry.sources.splice(sourceIndex, 1);
      entry.summaryLines.splice(sourceIndex, 1);
      entry.count = entry.sources.length;
      queue.evictedSummaryCount += 1;
      sourceCount -= 1;
      if (source) {
        if (options?.deferLifecycleCompletion) {
          deferredCompletions.push(source);
        } else {
          completeFollowupRunLifecycle(source);
        }
      }
      if (entry.sources.length === 0) {
        queue.summaryElisions.splice(entryIndex, 1);
      }
      evicted = true;
      break;
    }
    if (!evicted) {
      // A deferred delivery temporarily retains at most one queue-cap-sized active set.
      return deferredCompletions;
    }
  }
  return deferredCompletions;
}

function persistCapDrivenElisionTrim(queue: FollowupQueueState): void {
  const snapshotElisions = queue.summaryElisions.map((elision) => ({
    contextKey: elision.contextKey,
    count: elision.count,
    sources: elision.sources.slice(),
    summaryLines: elision.summaryLines.slice(),
    sourceRefs: elision.sourceRefs,
  }));
  const snapshotEvictedSummaryCount = queue.evictedSummaryCount;
  const deferredCompletions = trimSummaryElisionsToCap(queue, { deferLifecycleCompletion: true });
  if (
    deferredCompletions.length === 0 &&
    queue.evictedSummaryCount === snapshotEvictedSummaryCount
  ) {
    return;
  }
  try {
    persistFollowupQueuesOrThrow();
  } catch (err) {
    queue.summaryElisions.splice(0, queue.summaryElisions.length, ...snapshotElisions);
    queue.evictedSummaryCount = snapshotEvictedSummaryCount;
    throw err;
  }
  for (const source of deferredCompletions) {
    completeFollowupRunLifecycle(source);
  }
}

export function getFollowupQueue(key: string, settings: QueueSettings): FollowupQueueState {
  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    ensureFollowupQueueSummaryState(existing);
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    persistCapDrivenElisionTrim(existing);
    return existing;
  }

  const created: FollowupQueueState = {
    abortController: new AbortController(),
    items: [],
    draining: false,
    inFlight: new Set(),
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs:
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap:
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : DEFAULT_QUEUE_CAP,
    dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
    summarySources: [],
    steerAcceptanceTail: Promise.resolve(true),
    activeSummarySources: new WeakSet(),
    summaryElisions: [],
    evictedSummaryCount: 0,
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  FOLLOWUP_QUEUES.set(key, created);
  return created;
}

export function clearFollowupQueue(key: string): number {
  const cleaned = key.trim();
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return 0;
  }
  const clearedItems = queue.items.slice();
  const clearedSummarySources = queue.summarySources.slice();
  const clearedSummaryElisions = queue.summaryElisions.map((elision) => ({
    contextKey: elision.contextKey,
    count: elision.count,
    sources: elision.sources.slice(),
    summaryLines: elision.summaryLines.slice(),
    sourceRefs: elision.sourceRefs,
  }));
  const clearedSummaryLines = queue.summaryLines.slice();
  const clearedInFlight = [...queue.inFlight];
  const clearedDroppedCount = queue.droppedCount;
  const clearedLastRun = queue.lastRun;
  const clearedLastEnqueuedAt = queue.lastEnqueuedAt;
  const clearedEvictedSummaryCount = queue.evictedSummaryCount;
  const cleared = clearedItems.length + clearedDroppedCount;

  // Wipe durable + memory state first. Abort only after SQLite acknowledges the
  // clear so a failed write can restore prior work with live queue abort signals.
  queue.items.length = 0;
  queue.inFlight.clear();
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.summarySources = [];
  queue.summaryElisions = [];
  queue.evictedSummaryCount = 0;
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  FOLLOWUP_QUEUES.delete(cleaned);
  try {
    persistFollowupQueuesOrThrow();
  } catch (err) {
    queue.items.splice(0, 0, ...clearedItems);
    queue.summarySources.splice(0, 0, ...clearedSummarySources);
    queue.summaryElisions.splice(0, 0, ...clearedSummaryElisions);
    queue.summaryLines.splice(0, 0, ...clearedSummaryLines);
    for (const item of clearedInFlight) {
      queue.inFlight.add(item);
    }
    queue.droppedCount = clearedDroppedCount;
    queue.lastRun = clearedLastRun;
    queue.lastEnqueuedAt = clearedLastEnqueuedAt;
    queue.evictedSummaryCount = clearedEvictedSummaryCount;
    FOLLOWUP_QUEUES.set(cleaned, queue);
    throw err;
  }
  queue.abortController.abort();
  for (const item of clearedItems) {
    completeFollowupRunLifecycle(item);
  }
  for (const item of clearedSummarySources) {
    completeFollowupRunLifecycle(item);
  }
  for (const entry of clearedSummaryElisions) {
    for (const source of entry.sources) {
      completeFollowupRunLifecycle(source);
    }
  }
  return cleared;
}

export function refreshQueuedFollowupSession(params: {
  key: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
  nextProvider?: string;
  nextModel?: string;
  nextRouteResolution?: ModelFallbackRouteResolution;
  nextModelOverrideSource?: "auto" | "user";
  nextAuthProfileId?: string;
  nextAuthProfileIdSource?: "auto" | "user";
  nextThinking?: {
    level?: string;
    catalog?: ThinkingCatalogEntry[];
    agentRuntime?: string | null;
  };
}): void {
  const cleaned = params.key.trim();
  if (!cleaned) {
    return;
  }
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return;
  }
  const shouldRewriteSession =
    Boolean(params.previousSessionId) &&
    Boolean(params.nextSessionId) &&
    params.previousSessionId !== params.nextSessionId;
  const hasNextModelRoute =
    typeof params.nextProvider === "string" || typeof params.nextModel === "string";
  const shouldRewriteModelSelection =
    hasNextModelRoute || Object.hasOwn(params, "nextModelOverrideSource");
  const shouldRewriteSelection =
    shouldRewriteModelSelection ||
    Object.hasOwn(params, "nextAuthProfileId") ||
    Object.hasOwn(params, "nextAuthProfileIdSource") ||
    params.nextThinking !== undefined;
  if (!shouldRewriteSession && !shouldRewriteSelection) {
    return;
  }

  const rewriteRun = (run?: FollowupRun["run"]) => {
    if (!run) {
      return;
    }
    if (shouldRewriteSession && run.sessionId === params.previousSessionId) {
      run.sessionId = params.nextSessionId!;
      const nextSessionFile = normalizeOptionalString(params.nextSessionFile);
      if (nextSessionFile) {
        run.sessionFile = nextSessionFile;
      }
    }
    if (shouldRewriteSelection) {
      if (typeof params.nextProvider === "string") {
        run.provider = params.nextProvider;
      }
      if (typeof params.nextModel === "string") {
        run.model = params.nextModel;
      }
      if (hasNextModelRoute) {
        run.requestedRouteResolution = params.nextRouteResolution ?? "raw";
      }
      if (shouldRewriteModelSelection) {
        delete run.hasAutoFallbackProvenance;
      }
      if (Object.hasOwn(params, "nextModelOverrideSource")) {
        run.hasSessionModelOverride =
          params.nextModelOverrideSource !== undefined && Boolean(run.provider || run.model);
        run.modelOverrideSource = params.nextModelOverrideSource;
      }
      if (Object.hasOwn(params, "nextAuthProfileId")) {
        run.authProfileId = normalizeOptionalString(params.nextAuthProfileId);
      }
      if (Object.hasOwn(params, "nextAuthProfileIdSource")) {
        run.authProfileIdSource = run.authProfileId ? params.nextAuthProfileIdSource : undefined;
      }
      if (params.nextThinking) {
        run.thinkingCatalog = params.nextThinking.catalog;
        const explicitLevel = normalizeThinkLevel(params.nextThinking.level);
        run.thinkLevel = explicitLevel
          ? resolveSupportedThinkingLevel({
              provider: run.provider,
              model: run.model,
              level: explicitLevel,
              catalog: params.nextThinking.catalog,
              agentRuntime: params.nextThinking.agentRuntime,
            })
          : resolveThinkingDefaultForModel({
              provider: run.provider,
              model: run.model,
              catalog: params.nextThinking.catalog,
              agentRuntime: params.nextThinking.agentRuntime,
            });
      }
    }
  };

  const snapshotRunFields = (run: FollowupRun["run"]) => ({
    sessionId: run.sessionId,
    sessionFile: run.sessionFile,
    provider: run.provider,
    model: run.model,
    requestedRouteResolution: run.requestedRouteResolution,
    hasAutoFallbackProvenance: run.hasAutoFallbackProvenance,
    hasSessionModelOverride: run.hasSessionModelOverride,
    modelOverrideSource: run.modelOverrideSource,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
    thinkingCatalog: run.thinkingCatalog,
    thinkLevel: run.thinkLevel,
  });
  const priorRuns = [
    ...(queue.lastRun ? [queue.lastRun] : []),
    ...queue.items.map((item) => item.run),
    ...queue.summarySources.map((item) => item.run),
    ...queue.summaryElisions.flatMap((entry) => entry.sources.map((source) => source.run)),
  ];
  const priorSnapshots = priorRuns.map((run) => ({ run, fields: snapshotRunFields(run) }));

  rewriteRun(queue.lastRun);
  for (const item of queue.items) {
    rewriteRun(item.run);
  }
  for (const item of queue.summarySources) {
    rewriteRun(item.run);
  }
  for (const entry of queue.summaryElisions) {
    for (const source of entry.sources) {
      rewriteRun(source.run);
    }
  }
  try {
    persistFollowupQueuesOrThrow();
  } catch (err) {
    for (const { run, fields } of priorSnapshots) {
      run.sessionId = fields.sessionId;
      run.sessionFile = fields.sessionFile;
      run.provider = fields.provider;
      run.model = fields.model;
      run.requestedRouteResolution = fields.requestedRouteResolution;
      if (fields.hasAutoFallbackProvenance === undefined) {
        delete run.hasAutoFallbackProvenance;
      } else {
        run.hasAutoFallbackProvenance = fields.hasAutoFallbackProvenance;
      }
      if (fields.hasSessionModelOverride === undefined) {
        delete run.hasSessionModelOverride;
      } else {
        run.hasSessionModelOverride = fields.hasSessionModelOverride;
      }
      run.modelOverrideSource = fields.modelOverrideSource;
      run.authProfileId = fields.authProfileId;
      run.authProfileIdSource = fields.authProfileIdSource;
      run.thinkingCatalog = fields.thinkingCatalog;
      run.thinkLevel = fields.thinkLevel;
    }
    throw err;
  }
}

restoreFollowupQueues();
