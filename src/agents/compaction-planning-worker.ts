/**
 * Runs CPU-heavy compaction planning in a worker thread when histories are
 * large enough to risk starving the main event loop.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { toErrorObject } from "../infra/errors.js";
import {
  buildHistoryPrunePlan,
  buildOversizedFallbackPlan,
  buildStageSplitPlan,
  buildSummaryChunks,
  computeAdaptiveChunkRatio,
  projectCompactionMessagesForPlanning,
  sanitizeCompactionMessages,
  type HistoryPrunePlan,
  type OversizedFallbackPlan,
  type StageSplitPlan,
} from "./compaction-planning.js";
import type {
  CompactionPlanningWorkerInput,
  CompactionPlanningWorkerResult,
  CompactionPlanningWorkerValue,
} from "./compaction-planning.worker.js";
import type { AgentMessage } from "./runtime/index.js";

const COMPACTION_PLANNING_WORKER_TIMEOUT_MS = 60_000;
// Worker startup is more expensive than local planning for tiny histories.
// Keep small compactions synchronous; move only starvation-sized plans off-thread.
const COMPACTION_PLANNING_WORKER_MIN_MESSAGES = 64;

class CompactionPlanningWorkerError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "timeout" | "failed",
  ) {
    super(message);
    this.name = "CompactionPlanningWorkerError";
  }
}

function resolveCompactionPlanningWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(path.join(distRoot, "agents", "compaction-planning.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./compaction-planning.worker${extension}`, currentModuleUrl);
}

function runCompactionPlanningWorker(params: {
  input: CompactionPlanningWorkerInput;
  signal?: AbortSignal;
  timeoutMs?: number;
  workerUrl?: URL;
}): Promise<CompactionPlanningWorkerValue> {
  if (params.signal?.aborted) {
    return Promise.reject(
      toErrorObject(
        params.signal.reason ?? new Error("compaction planning aborted"),
        "Non-Error rejection",
      ),
    );
  }

  const workerUrl = params.workerUrl ?? resolveCompactionPlanningWorkerUrl();
  const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: params.input,
      execArgv: sourceWorkerExecArgv,
    });
  } catch (error) {
    return Promise.reject(
      new CompactionPlanningWorkerError(
        error instanceof Error ? error.message : String(error),
        "unavailable",
      ),
    );
  }

  worker.unref?.();

  return new Promise<CompactionPlanningWorkerValue>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => {
        settle(
          () =>
            reject(
              new CompactionPlanningWorkerError("compaction planning worker timed out", "timeout"),
            ),
          true,
        );
      },
      resolveTimerTimeoutMs(params.timeoutMs, COMPACTION_PLANNING_WORKER_TIMEOUT_MS),
    );

    const abort = () => {
      settle(
        () =>
          reject(
            toErrorObject(
              params.signal?.reason ?? new Error("compaction planning aborted"),
              "Non-Error rejection",
            ),
          ),
        true,
      );
    };

    const settle = (finish: () => void, terminate: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
      if (terminate) {
        void worker.terminate();
      }
      finish();
    };

    params.signal?.addEventListener("abort", abort, { once: true });

    worker.once("message", (message: CompactionPlanningWorkerResult) => {
      settle(() => {
        if (message.status === "ok") {
          resolve(message.value);
          return;
        }
        reject(new CompactionPlanningWorkerError(message.error, "failed"));
      }, false);
    });
    worker.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      settle(() => reject(new CompactionPlanningWorkerError(message, "unavailable")), true);
    });
    worker.once("exit", (code) => {
      if (code === 0) {
        return;
      }
      settle(
        () =>
          reject(
            new CompactionPlanningWorkerError(
              `compaction planning worker exited with code ${code}`,
              "unavailable",
            ),
          ),
        false,
      );
    });
  });
}

function shouldFallbackToMainThread(error: unknown): boolean {
  return error instanceof CompactionPlanningWorkerError && error.code === "unavailable";
}

function shouldUsePlanningWorker(messageCount: number): boolean {
  return messageCount >= COMPACTION_PLANNING_WORKER_MIN_MESSAGES;
}

function indexSelectedMessages(
  indexByMessage: ReadonlyMap<AgentMessage, number>,
  selected: AgentMessage[],
): number[] {
  return selected.map((message) => {
    const index = indexByMessage.get(message);
    if (index === undefined) {
      throw new CompactionPlanningWorkerError(
        "compaction planning result contains an unknown message",
        "failed",
      );
    }
    return index;
  });
}

function indexMessageChunks(source: AgentMessage[], chunks: AgentMessage[][]): number[][] {
  const indexByMessage = new Map(source.map((message, index) => [message, index]));
  return chunks.map((chunk) => indexSelectedMessages(indexByMessage, chunk));
}

function indexOversizedFallbackPlan(
  source: AgentMessage[],
  plan: OversizedFallbackPlan,
): Extract<CompactionPlanningWorkerValue, { kind: "oversizedFallback" }> {
  return {
    kind: "oversizedFallback",
    smallMessageIndexes: indexSelectedMessages(
      new Map(source.map((message, index) => [message, index])),
      plan.smallMessages,
    ),
    oversizedNotes: plan.oversizedNotes,
  };
}

function indexStageSplitPlan(
  source: AgentMessage[],
  plan: StageSplitPlan,
): Extract<CompactionPlanningWorkerValue, { kind: "stageSplit" }> {
  return plan.mode === "split"
    ? {
        kind: "stageSplit",
        mode: "split",
        chunkIndexes: indexMessageChunks(source, plan.chunks),
      }
    : { kind: "stageSplit", mode: "single" };
}

function restoreIndexedMessages(source: AgentMessage[], indexes: number[]): AgentMessage[] {
  return indexes.map((index) => {
    const message = source.at(index);
    if (!Number.isInteger(index) || index < 0 || !message) {
      throw new CompactionPlanningWorkerError(
        "compaction planning result contains an invalid message index",
        "failed",
      );
    }
    return message;
  });
}

async function runWithUnavailableFallback<T extends CompactionPlanningWorkerValue>(params: {
  input: CompactionPlanningWorkerInput;
  signal?: AbortSignal;
  fallback: () => T;
  isExpected: (value: CompactionPlanningWorkerValue) => value is T;
}): Promise<T> {
  try {
    const value = await runCompactionPlanningWorker({
      input: params.input,
      signal: params.signal,
    });
    if (params.isExpected(value)) {
      return value;
    }
    throw new CompactionPlanningWorkerError(
      "unexpected compaction planning worker result",
      "failed",
    );
  } catch (error) {
    if (shouldFallbackToMainThread(error)) {
      return params.fallback();
    }
    throw error;
  }
}

/** Builds summary chunks, offloading large histories to the planning worker. */
export async function buildSummaryChunksWithWorker(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
  signal?: AbortSignal;
}): Promise<AgentMessage[][]> {
  const messages = sanitizeCompactionMessages(params.messages);
  if (!shouldUsePlanningWorker(messages.length)) {
    return buildSummaryChunks(params);
  }
  const planningMessages = projectCompactionMessagesForPlanning(messages);
  const value = await runWithUnavailableFallback({
    input: {
      kind: "summaryChunks",
      messages: planningMessages,
      maxChunkTokens: params.maxChunkTokens,
    },
    signal: params.signal,
    fallback: () => ({
      kind: "summaryChunks" as const,
      chunkIndexes: indexMessageChunks(
        messages,
        buildSummaryChunks({ messages, maxChunkTokens: params.maxChunkTokens }),
      ),
    }),
    isExpected: (
      valueCandidate,
    ): valueCandidate is Extract<CompactionPlanningWorkerValue, { kind: "summaryChunks" }> =>
      valueCandidate.kind === "summaryChunks",
  });
  return value.chunkIndexes.map((indexes) => restoreIndexedMessages(messages, indexes));
}

/** Builds an oversized-message fallback plan, using the worker when worthwhile. */
export async function buildOversizedFallbackPlanWithWorker(params: {
  messages: AgentMessage[];
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<OversizedFallbackPlan> {
  const messages = sanitizeCompactionMessages(params.messages);
  if (!shouldUsePlanningWorker(messages.length)) {
    return buildOversizedFallbackPlan(params);
  }
  const planningMessages = projectCompactionMessagesForPlanning(messages);
  const value = await runWithUnavailableFallback({
    input: {
      kind: "oversizedFallback",
      messages: planningMessages,
      contextWindow: params.contextWindow,
    },
    signal: params.signal,
    fallback: () =>
      indexOversizedFallbackPlan(
        messages,
        buildOversizedFallbackPlan({ messages, contextWindow: params.contextWindow }),
      ),
    isExpected: (
      valueEntry,
    ): valueEntry is Extract<CompactionPlanningWorkerValue, { kind: "oversizedFallback" }> =>
      valueEntry.kind === "oversizedFallback",
  });
  return {
    smallMessages: restoreIndexedMessages(messages, value.smallMessageIndexes),
    oversizedNotes: value.oversizedNotes,
  };
}

/** Builds a staged summarization split plan with worker fallback. */
export async function buildStageSplitPlanWithWorker(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
  parts?: number;
  minMessagesForSplit?: number;
  signal?: AbortSignal;
}): Promise<StageSplitPlan> {
  const messages = sanitizeCompactionMessages(params.messages);
  if (!shouldUsePlanningWorker(messages.length)) {
    return buildStageSplitPlan(params);
  }
  const planningMessages = projectCompactionMessagesForPlanning(messages);
  const value = await runWithUnavailableFallback({
    input: {
      kind: "stageSplit",
      messages: planningMessages,
      maxChunkTokens: params.maxChunkTokens,
      parts: params.parts,
      minMessagesForSplit: params.minMessagesForSplit,
    },
    signal: params.signal,
    fallback: () =>
      indexStageSplitPlan(
        messages,
        buildStageSplitPlan({
          messages,
          maxChunkTokens: params.maxChunkTokens,
          parts: params.parts,
          minMessagesForSplit: params.minMessagesForSplit,
        }),
      ),
    isExpected: (
      valueResult,
    ): valueResult is Extract<CompactionPlanningWorkerValue, { kind: "stageSplit" }> =>
      valueResult.kind === "stageSplit",
  });
  return value.mode === "split"
    ? {
        mode: "split",
        chunks: value.chunkIndexes.map((indexes) => restoreIndexedMessages(messages, indexes)),
      }
    : { mode: "single" };
}

/**
 * Builds a history-pruning plan on the owner thread.
 *
 * Pruning repairs tool-result pairs and returns exact retained/dropped messages,
 * so a bounded selection projection cannot reconstruct every result faithfully.
 */
export async function buildHistoryPrunePlanWithWorker(params: {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  tokensBefore: number;
  contextWindowTokens: number;
  maxHistoryShare: number;
  parts?: number;
  signal?: AbortSignal;
}): Promise<HistoryPrunePlan> {
  return buildHistoryPrunePlan(params);
}

/** Computes the adaptive compaction chunk ratio with worker fallback. */
export async function computeAdaptiveChunkRatioWithWorker(params: {
  messages: AgentMessage[];
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<number> {
  const messages = sanitizeCompactionMessages(params.messages);
  if (!shouldUsePlanningWorker(messages.length)) {
    return computeAdaptiveChunkRatio(params.messages, params.contextWindow);
  }
  const planningMessages = projectCompactionMessagesForPlanning(messages);
  const value = await runWithUnavailableFallback({
    input: {
      kind: "adaptiveChunkRatio",
      messages: planningMessages,
      contextWindow: params.contextWindow,
    },
    signal: params.signal,
    fallback: () => ({
      kind: "adaptiveChunkRatio" as const,
      ratio: computeAdaptiveChunkRatio(params.messages, params.contextWindow),
    }),
    isExpected: (
      valueLocal,
    ): valueLocal is Extract<CompactionPlanningWorkerValue, { kind: "adaptiveChunkRatio" }> =>
      valueLocal.kind === "adaptiveChunkRatio",
  });
  return value.ratio;
}

const compactionPlanningWorkerTesting = {
  resolveCompactionPlanningWorkerUrl,
  runCompactionPlanningWorker,
  CompactionPlanningWorkerError,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.compactionPlanningWorkerTestApi")
  ] = compactionPlanningWorkerTesting;
}
