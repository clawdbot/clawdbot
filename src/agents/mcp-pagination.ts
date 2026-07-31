/** Shared bounded pagination for MCP list operations. */
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

export type McpPaginationPage<T> = {
  items: readonly T[];
  nextCursor?: string;
  /** Original SDK page used for the aggregate serialized-byte budget. */
  serializedValue?: unknown;
};

export type McpPaginationRequest = {
  cursor: string | undefined;
  timeoutMs: number;
  signal: AbortSignal;
};

type CollectMcpPaginatedItemsParams<TInput, TOutput = TInput> = {
  label: string;
  itemLabel: string;
  timeoutMs: number;
  maxPages: number;
  maxItems: number;
  maxBytes: number;
  signal?: AbortSignal;
  loadPage: (request: McpPaginationRequest) => Promise<McpPaginationPage<TInput>>;
  mapItem?: (item: TInput) => TOutput | undefined;
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function abortError(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`);
}

/** Collects one complete MCP list under a single bounded lifecycle. */
export async function collectMcpPaginatedItems<TInput, TOutput = TInput>(
  params: CollectMcpPaginatedItemsParams<TInput, TOutput>,
): Promise<TOutput[]> {
  const timeoutMs = clampPositiveTimerTimeoutMs(params.timeoutMs);
  if (timeoutMs === undefined) {
    throw new Error(`${params.label} requires a positive timeout`);
  }
  const maxPages = positiveInteger(params.maxPages, `${params.label} maxPages`);
  const maxItems = positiveInteger(params.maxItems, `${params.label} maxItems`);
  const maxBytes = positiveInteger(params.maxBytes, `${params.label} maxBytes`);

  const deadlineController = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadlineController.signal])
    : deadlineController.signal;
  if (signal.aborted) {
    throw abortError(signal, params.label);
  }
  const deadlineAtMs = Date.now() + timeoutMs;
  const timeoutError = new Error(`${params.label} timed out after ${timeoutMs}ms`);
  const deadlineTimer = setTimeout(() => deadlineController.abort(timeoutError), timeoutMs);
  deadlineTimer.unref?.();

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal, params.label));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const items: TOutput[] = [];
  const seenCursors = new Set<string>();
  let collectedBytes = 0;
  let cursor: string | undefined;

  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      signal.throwIfAborted();
      const remainingTimeoutMs = clampPositiveTimerTimeoutMs(deadlineAtMs - Date.now());
      if (remainingTimeoutMs === undefined) {
        throw timeoutError;
      }
      const page = await Promise.race([
        params.loadPage({ cursor, timeoutMs: remainingTimeoutMs, signal }),
        aborted,
      ]);
      const measured = boundedJsonUtf8Bytes(
        page.serializedValue ?? { items: page.items, nextCursor: page.nextCursor },
        maxBytes - collectedBytes,
      );
      if (!measured.complete || collectedBytes + measured.bytes > maxBytes) {
        throw new Error(`${params.label} exceeded ${maxBytes} bytes`);
      }
      collectedBytes += measured.bytes;

      for (const item of page.items) {
        const mapped = params.mapItem ? params.mapItem(item) : (item as unknown as TOutput);
        if (mapped === undefined) {
          continue;
        }
        if (items.length >= maxItems) {
          throw new Error(`${params.label} exceeded ${maxItems} ${params.itemLabel}`);
        }
        items.push(mapped);
      }

      const nextCursor = page.nextCursor;
      if (nextCursor === undefined) {
        return items;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`${params.label} returned a repeated pagination cursor`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error(`${params.label} exceeded ${maxPages} pages`);
  } finally {
    clearTimeout(deadlineTimer);
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
