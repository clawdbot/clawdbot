import { expectDefined } from "@openclaw/normalization-core";
/**
 * Shared queue overflow, debounce, and collection helpers.
 *
 * Queue owners use these helpers to cap pending work, summarize dropped items,
 * debounce drains, and force individual collection when cross-channel ordering matters.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Mutable summary state for a capped queue. */
type QueueSummaryState = {
  dropPolicy: "summarize" | "old" | "new";
  droppedCount: number;
  summaryLines: string[];
};

/** Queue overflow strategy. */
type QueueDropPolicy = QueueSummaryState["dropPolicy"];

/** Generic capped queue state with shared overflow summary fields. */
type QueueState<T> = QueueSummaryState & {
  items: T[];
  cap: number;
};

/** Clear accumulated overflow summary state after it has been emitted. */
export function clearQueueSummaryState(state: QueueSummaryState): void {
  state.droppedCount = 0;
  state.summaryLines = [];
}

/** Build a summary prompt preview without mutating the source queue state. */
export function previewQueueSummaryPrompt(params: {
  state: QueueSummaryState;
  noun: string;
  title?: string;
}): string | undefined {
  return buildQueueSummaryPrompt({
    state: {
      dropPolicy: params.state.dropPolicy,
      droppedCount: params.state.droppedCount,
      summaryLines: [...params.state.summaryLines],
    },
    noun: params.noun,
    title: params.title,
  });
}

/** Apply runtime queue settings while preserving previous values for omitted fields. */
export function applyQueueRuntimeSettings<TMode extends string>(params: {
  target: {
    mode: TMode;
    debounceMs: number;
    cap: number;
    dropPolicy: QueueDropPolicy;
  };
  settings: {
    mode: TMode;
    debounceMs?: number;
    cap?: number;
    dropPolicy?: QueueDropPolicy;
  };
}): void {
  params.target.mode = params.settings.mode;
  params.target.debounceMs =
    typeof params.settings.debounceMs === "number"
      ? Math.max(0, params.settings.debounceMs)
      : params.target.debounceMs;
  params.target.cap =
    typeof params.settings.cap === "number" && params.settings.cap > 0
      ? Math.floor(params.settings.cap)
      : params.target.cap;
  params.target.dropPolicy = params.settings.dropPolicy ?? params.target.dropPolicy;
}

/** Trim queue summary text to a bounded single-line preview. */
function elideQueueText(text: string, limit = 140): string {
  if (text.length <= limit) {
    return text;
  }
  return `${truncateUtf16Safe(text, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Normalize whitespace and elide one dropped item for queue summaries. */
function buildQueueSummaryLine(text: string, limit = 160): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return elideQueueText(cleaned, limit);
}

/** Run optional duplicate detection before an item enters a queue. */
export function shouldSkipQueueItem<T>(params: {
  item: T;
  items: T[];
  dedupe?: (item: T, items: T[]) => boolean;
}): boolean {
  if (!params.dedupe) {
    return false;
  }
  return params.dedupe(params.item, params.items);
}

/** Count identities that are still pending in the queue, excluding active deliveries. */
export function countPendingQueueItems<T>(items: readonly T[], inFlight?: ReadonlySet<T>): number {
  if (!inFlight || inFlight.size === 0) {
    return items.length;
  }
  return items.reduce((count, item) => count + (inFlight.has(item) ? 0 : 1), 0);
}

type DrainQueueItemOptions<T> = {
  inFlight?: Set<T>;
  shouldRestoreOnError?: (item: T) => boolean;
  onDiscard?: (item: T) => void;
};

/** Apply overflow policy before enqueueing another item. */
export function applyQueueDropPolicy<T>(params: {
  queue: QueueState<T>;
  summarize: (item: T) => string;
  summaryLimit?: number;
  onDrop?: (items: T[]) => void;
  inFlight?: ReadonlySet<T>;
  isProtected?: (item: T) => boolean;
}): boolean {
  const cap = params.queue.cap;
  const pendingCount = countPendingQueueItems(params.queue.items, params.inFlight);
  if (cap <= 0 || pendingCount < cap) {
    return true;
  }
  if (params.queue.dropPolicy === "new") {
    return false;
  }
  const dropCount = pendingCount - cap + 1;
  // Collect victim indices first. In-flight identities stay until delivery
  // succeeds; protected priority runs (e.g. stranded-reply retries) also stay.
  // Only mutate the queue when enough victims exist so a partial drop cannot
  // admit overflow when the queue is full of in-flight/protected work.
  const victimIndices: number[] = [];
  for (const [index, item] of params.queue.items.entries()) {
    if (params.inFlight?.has(item) || params.isProtected?.(item) === true) {
      continue;
    }
    victimIndices.push(index);
    if (victimIndices.length === dropCount) {
      break;
    }
  }
  if (victimIndices.length < dropCount) {
    return false;
  }
  const dropped: T[] = [];
  for (let i = victimIndices.length - 1; i >= 0; i -= 1) {
    dropped.unshift(
      ...params.queue.items.splice(expectDefined(victimIndices[i], "victim indices entry at i"), 1),
    );
  }
  params.onDrop?.(dropped);
  if (params.queue.dropPolicy === "summarize") {
    for (const item of dropped) {
      params.queue.droppedCount += 1;
      params.queue.summaryLines.push(buildQueueSummaryLine(params.summarize(item)));
    }
    // Summary memory is bounded independently from the item cap to avoid prompt blowups.
    const limit = Math.max(0, params.summaryLimit ?? cap);
    while (params.queue.summaryLines.length > limit) {
      params.queue.summaryLines.shift();
    }
  }
  return true;
}

/** Wait until the queue has been quiet for its debounce window. */
export function waitForQueueDebounce(
  queue: {
    debounceMs: number;
    lastEnqueuedAt: number;
  },
  abortSignal?: AbortSignal,
): Promise<void> {
  if (process.env.OPENCLAW_TEST_FAST === "1") {
    // Tests use this escape hatch so debounce logic does not slow deterministic queue specs.
    return Promise.resolve();
  }
  const debounceMs = Math.max(0, queue.debounceMs);
  if (debounceMs <= 0) {
    return Promise.resolve();
  }
  if (abortSignal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      abortSignal?.removeEventListener("abort", finish);
      resolve();
    };
    const check = () => {
      if (abortSignal?.aborted) {
        finish();
        return;
      }
      const since = Date.now() - queue.lastEnqueuedAt;
      if (since >= debounceMs) {
        finish();
        return;
      }
      timer = setTimeout(check, debounceMs - since);
    };
    abortSignal?.addEventListener("abort", finish, { once: true });
    check();
  });
}

/** Mark one queue as draining unless another drain is already active. */
export function beginQueueDrain<T extends { draining: boolean }>(
  map: Map<string, T>,
  key: string,
): T | undefined {
  const queue = map.get(key);
  if (!queue || queue.draining) {
    return undefined;
  }
  queue.draining = true;
  return queue;
}

export function removeQueuedItemsByRef<T>(items: T[], processed: readonly T[]): void {
  for (const item of processed) {
    const idx = items.indexOf(item);
    if (idx !== -1) {
      items.splice(idx, 1);
    }
  }
}

/** Run and remove the next queued item, returning false when empty. */
export async function drainNextQueueItem<T>(
  items: T[],
  run: (item: T) => Promise<void>,
  options?: DrainQueueItemOptions<T>,
): Promise<boolean> {
  const next = items[0];
  if (!next) {
    return false;
  }
  // Mark the item as in-flight so applyQueueDropPolicy skips it during the
  // await window when the shared items array is still mutated by enqueuers.
  options?.inFlight?.add(next);
  try {
    await run(next);
    // Keep the identity protected until its successful by-reference removal.
    removeQueuedItemsByRef(items, [next]);
  } catch (error) {
    if (!(options?.shouldRestoreOnError?.(next) ?? true)) {
      removeQueuedItemsByRef(items, [next]);
      options?.onDiscard?.(next);
    }
    throw error;
  } finally {
    options?.inFlight?.delete(next);
  }
  return true;
}

/** Drain one item when collect mode requires individual processing. */
async function drainCollectItemIfNeeded<T>(params: {
  forceIndividualCollect: boolean;
  isCrossChannel: boolean;
  setForceIndividualCollect?: (next: boolean) => void;
  items: T[];
  run: (item: T) => Promise<void>;
  reserveOptions?: DrainQueueItemOptions<T>;
}): Promise<"skipped" | "drained" | "empty"> {
  if (!params.forceIndividualCollect && !params.isCrossChannel) {
    return "skipped";
  }
  if (params.isCrossChannel) {
    // Once cross-channel items appear, future collection stays individual to preserve ordering.
    params.setForceIndividualCollect?.(true);
  }
  const drained = await drainNextQueueItem(params.items, params.run, params.reserveOptions);
  return drained ? "drained" : "empty";
}

/** Drain one collect step using mutable queue collection state. */
export async function drainCollectQueueStep<T>(params: {
  collectState: { forceIndividualCollect: boolean };
  isCrossChannel: boolean;
  items: T[];
  run: (item: T) => Promise<void>;
  reserveOptions?: DrainQueueItemOptions<T>;
}): Promise<"skipped" | "drained" | "empty"> {
  return await drainCollectItemIfNeeded({
    forceIndividualCollect: params.collectState.forceIndividualCollect,
    isCrossChannel: params.isCrossChannel,
    setForceIndividualCollect: (next) => {
      params.collectState.forceIndividualCollect = next;
    },
    items: params.items,
    run: params.run,
    reserveOptions: params.reserveOptions,
  });
}

/** Build and consume the queue overflow summary prompt. */
function buildQueueSummaryPrompt(params: {
  state: QueueSummaryState;
  noun: string;
  title?: string;
}): string | undefined {
  if (params.state.dropPolicy !== "summarize" || params.state.droppedCount <= 0) {
    return undefined;
  }
  const noun = params.noun;
  const title =
    params.title ??
    `[Queue overflow] Dropped ${params.state.droppedCount} ${noun}${params.state.droppedCount === 1 ? "" : "s"} due to cap.`;
  const lines = [title];
  if (params.state.summaryLines.length > 0) {
    lines.push("Summary:");
    for (const line of params.state.summaryLines) {
      lines.push(`- ${line}`);
    }
  }
  clearQueueSummaryState(params.state);
  return lines.join("\n");
}

/** Render a collect prompt from queued items and optional overflow summary. */
export function buildCollectPrompt<T>(params: {
  title: string;
  items: T[];
  summary?: string;
  renderItem: (item: T, index: number) => string;
}): string {
  const blocks: string[] = [params.title];
  if (params.summary) {
    blocks.push(params.summary);
  }
  params.items.forEach((item, idx) => {
    blocks.push(params.renderItem(item, idx));
  });
  return blocks.join("\n\n");
}

/** Return true when queued items span keys or explicitly mark cross-channel state. */
export function hasCrossChannelItems<T>(
  items: T[],
  resolveKey: (item: T) => { key?: string; cross?: boolean },
): boolean {
  const keys = new Set<string>();

  for (const item of items) {
    const resolved = resolveKey(item);
    if (resolved.cross) {
      return true;
    }
    if (!resolved.key) {
      continue;
    }
    keys.add(resolved.key);
  }

  return keys.size > 1;
}
