import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { extractErrorCode, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  listMemoryCorpusSupplements,
  type MemoryCorpusSearchResult,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  createMemorySearchDeadlineError,
  DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
  isMemorySearchDeadlineError,
  resolveMemorySearchAbortError,
} from "./memory/search-deadline.js";

type MemoryCorpus = "memory" | "wiki";
const memoryCorpusDeadlineChecks = new WeakMap<AbortSignal, () => void>();
type MemorySupplement = ReturnType<typeof listMemoryCorpusSupplements>[number];
type MemorySupplementGetResult = NonNullable<
  Awaited<ReturnType<MemorySupplement["supplement"]["get"]>>
>;
type MemorySupplementReadResult = Omit<MemorySupplementGetResult, "content"> & {
  status: "ok";
  text: string;
};

export type MemoryCorpusFailure = { error: string; code?: string; deadline: boolean };
type UnavailableMemoryCorpus<T> = {
  corpus: MemoryCorpus;
  outcome: "unavailable";
  value: T;
} & MemoryCorpusFailure;

export type MemoryCorpusAttempt<T> =
  | { corpus: MemoryCorpus; outcome: "ok"; value: T }
  | UnavailableMemoryCorpus<T>
  | (Omit<UnavailableMemoryCorpus<T>, "outcome"> & { outcome: "partial" })
  | { corpus: MemoryCorpus; outcome: "not-registered" };

/**
 * Flattening the failure to a string is where provenance would be lost: a
 * provider is free to emit the very text this tool uses for its own timeout, so
 * the deadline is carried across the boundary as a flag taken from the error
 * object while it is still here. Callers that already hold a flattened error
 * pass the flag they were given.
 */
export function unavailableMemoryCorpus<T>(
  corpus: MemoryCorpus,
  value: T,
  error: unknown,
  deadline = isMemorySearchDeadlineError(error),
): UnavailableMemoryCorpus<T> {
  const code = extractErrorCode(error);
  return {
    corpus,
    outcome: "unavailable",
    value,
    error: formatErrorMessage(error),
    deadline,
    ...(code ? { code } : {}),
  };
}

async function raceMemoryCorpusSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    throw resolveMemorySearchAbortError(signal);
  }
  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(resolveMemorySearchAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    const task = Promise.resolve().then(run);
    const result = await Promise.race([task, aborted]);
    memoryCorpusDeadlineChecks.get(signal)?.();
    if (signal.aborted) {
      throw resolveMemorySearchAbortError(signal);
    }
    return result;
  } finally {
    removeAbort();
  }
}

export async function attemptMemoryCorpus<T>(params: {
  corpus: MemoryCorpus;
  signal: AbortSignal;
  unavailableValue: T;
  getPartialValue?: () => T | null;
  run: () => Promise<T>;
}): Promise<MemoryCorpusAttempt<T>> {
  try {
    return {
      corpus: params.corpus,
      outcome: "ok",
      value: await raceMemoryCorpusSignal(params.signal, params.run),
    };
  } catch (error) {
    const partial = isMemorySearchDeadlineError(error) ? params.getPartialValue?.() : null;
    if (partial != null) {
      return { ...unavailableMemoryCorpus(params.corpus, partial, error), outcome: "partial" };
    }
    return unavailableMemoryCorpus(params.corpus, params.unavailableValue, error);
  }
}

export async function runMemoryCorpusDeadline<T>(params: {
  operation: "memory_search" | "memory_get";
  parentSignal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (params.parentSignal?.aborted) {
    throw resolveMemorySearchAbortError(params.parentSignal);
  }
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeoutError = createMemorySearchDeadlineError(
    `${params.operation} timed out after ${DEFAULT_MEMORY_SEARCH_TIMEOUT_MS / 1000}s`,
  );
  const expire = () => controller.abort(timeoutError);
  const checkDeadline = () => {
    // A synchronous database operation can finish before an overdue timer is serviced.
    if (
      !controller.signal.aborted &&
      performance.now() - startedAt >= DEFAULT_MEMORY_SEARCH_TIMEOUT_MS
    ) {
      expire();
    }
  };
  memoryCorpusDeadlineChecks.set(controller.signal, checkDeadline);
  const timer = setTimeout(expire, DEFAULT_MEMORY_SEARCH_TIMEOUT_MS);
  timer.unref?.();
  const onParentAbort = () => controller.abort(resolveMemorySearchAbortError(params.parentSignal!));
  params.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const result = await params.run(controller.signal);
    if (params.parentSignal?.aborted) {
      throw resolveMemorySearchAbortError(params.parentSignal);
    }
    const alreadyAborted = controller.signal.aborted;
    checkDeadline();
    if (!alreadyAborted && controller.signal.aborted) {
      throw timeoutError;
    }
    return result;
  } finally {
    clearTimeout(timer);
    memoryCorpusDeadlineChecks.delete(controller.signal);
    params.parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export function composeMemoryCorpusMetadata(
  attempts: readonly MemoryCorpusAttempt<unknown>[],
  extraWarnings: readonly string[] = [],
) {
  const ordered = attempts.toSorted(
    (left, right) => Number(left.corpus === "wiki") - Number(right.corpus === "wiki"),
  );
  const warnings = ordered.flatMap((attempt) => {
    const label = attempt.corpus === "memory" ? "Memory" : "Wiki";
    if ("error" in attempt) {
      return [`${label} corpus ${attempt.outcome}: ${attempt.error}`];
    }
    return attempt.outcome === "not-registered" && ordered.length === 1
      ? [`${label} corpus is not registered; results do not cover that requested corpus.`]
      : [];
  });
  warnings.push(...extraWarnings);
  const errors = ordered.flatMap((attempt) => ("error" in attempt ? [attempt.error] : []));
  return {
    corpora: ordered.map((attempt) =>
      "error" in attempt
        ? { corpus: attempt.corpus, outcome: attempt.outcome, error: attempt.error }
        : { corpus: attempt.corpus, outcome: attempt.outcome },
    ),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

async function settleMemorySupplements<T>(params: {
  signal: AbortSignal;
  run: (registration: MemorySupplement) => Promise<T>;
  merge: (results: T[]) => T;
}): Promise<MemoryCorpusAttempt<T>> {
  const supplements = listMemoryCorpusSupplements().toSorted((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
  if (supplements.length === 0) {
    return { corpus: "wiki", outcome: "not-registered" };
  }
  const failures: Array<{ pluginId: string; error: string }> = [];
  const completed: Array<T | undefined> = Array.from({ length: supplements.length });
  try {
    await raceMemoryCorpusSignal(params.signal, () =>
      runTasksWithConcurrency({
        tasks: supplements.map((registration, index) => async () => {
          const result = await params.run(registration);
          completed[index] = result;
          return result;
        }),
        limit: Math.min(4, supplements.length),
        onTaskError: (error, index) => {
          failures.push({
            pluginId: supplements[index]!.pluginId,
            error: formatErrorMessage(error),
          });
        },
      }),
    );
  } catch (error) {
    return unavailableMemoryCorpus(
      "wiki",
      params.merge(completed.filter((result): result is T => result !== undefined)),
      error,
    );
  }
  const value = params.merge(completed.filter((result): result is T => result !== undefined));
  if (failures.length === 0) {
    return { corpus: "wiki", outcome: "ok", value };
  }
  const orderedFailures = failures.toSorted((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
  const error =
    orderedFailures.length === 1
      ? orderedFailures[0]!.error
      : orderedFailures.map((entry) => `${entry.pluginId}: ${entry.error}`).join("; ");
  // Individual supplement failures are the plugin's, never this tool's deadline.
  return { corpus: "wiki", outcome: "unavailable", value, error, deadline: false };
}

export async function searchMemoryCorpusSupplements(params: {
  query: string;
  maxResults?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  signal: AbortSignal;
}): Promise<MemoryCorpusAttempt<MemoryCorpusSearchResult[]>> {
  const { signal, ...query } = params;
  return await settleMemorySupplements({
    signal,
    run: async ({ supplement }) => await supplement.search(query),
    merge: (results) =>
      results
        .flat()
        .toSorted((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .slice(0, Math.max(1, params.maxResults ?? 10)),
  });
}

export async function readMemoryCorpusSupplements(params: {
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  signal: AbortSignal;
}): Promise<MemoryCorpusAttempt<MemorySupplementReadResult | null>> {
  const { signal, ...query } = params;
  return await settleMemorySupplements({
    signal,
    run: async ({ supplement }) => {
      const result = await supplement.get(query);
      if (!result) {
        return null;
      }
      const { content, ...details } = result;
      return { ...details, status: "ok", text: content };
    },
    merge: (results) => results.find((result) => result !== null) ?? null,
  });
}
