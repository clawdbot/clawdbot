import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  buildHistoryPrunePlan,
  buildOversizedFallbackPlan,
  buildStageSplitPlan,
  buildSummaryChunks,
  computeAdaptiveChunkRatio,
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
    return Promise.reject(params.signal.reason ?? new Error("compaction planning aborted"));
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
    const timeout = setTimeout(() => {
      settle(
        () =>
          reject(
            new CompactionPlanningWorkerError("compaction planning worker timed out", "timeout"),
          ),
        true,
      );
    }, params.timeoutMs ?? COMPACTION_PLANNING_WORKER_TIMEOUT_MS);

    const abort = () => {
      settle(() => reject(params.signal?.reason ?? new Error("compaction planning aborted")), true);
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

export async function buildSummaryChunksWithWorker(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
  signal?: AbortSignal;
}): Promise<AgentMessage[][]> {
  const messages = sanitizeCompactionMessages(params.messages);
  if (!shouldUsePlanningWorker(messages.length)) {
    return buildSummaryChunks(params);
  }
  const value = await runWithUnavailableFallback({
    input: {
      kind: "summaryChunks",
      messages,
      maxChunkTokens: params.maxChunkTokens,
    },
    signal: params.signal,
    fallback: () => ({
      kind: "summaryChunks" as const,
      chunks: buildSummaryChunks(params),
    }),
    isExpected: (
      value,
    ): value is Extract<CompactionPlanningWorkerValue, { kind: "summaryChunks" }> =>
      value.kind === "summaryChunks",
  });
  return value.chunks;
}

export async function buildOversizedFallbackPlanWithWorker(params: {
  messages: AgentMessage[];
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<OversizedFallbackPlan> {
  const messages = sanitizeCompactionMessages(params.messages);
  if (!shouldUsePlanningWorker(messages.length)) {
    return buildOversizedFallbackPlan(params);
  }
  const value = await runWithUnavailableFallback({
    input: {
      kind: "oversizedFallback",
      messages,
      contextWindow: params.contextWindow,
    },
    signal: params.signal,
    fallback: () => ({
      kind: "oversizedFallback" as const,
      ...buildOversizedFallbackPlan(params),
    }),
    isExpected: (
      value,
    ): value is Extract<CompactionPlanningWorkerValue, { kind: "oversizedFallback" }> =>
      value.kind === "oversizedFallback",
  });
  return {
    smallMessages: value.smallMessages,
    oversizedNotes: value.oversizedNotes,
  };
}

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
  const value = await runWithUnavailableFallback({
    input: {
      kind: "stageSplit",
      messages,
      maxChunkTokens: params.maxChunkTokens,
      parts: params.parts,
      minMessagesForSplit: params.minMessagesForSplit,
    },
    signal: params.signal,
    fallback: () => ({
      kind: "stageSplit" as const,
      ...buildStageSplitPlan(params),
    }),
    isExpected: (value): value is Extract<CompactionPlanningWorkerValue, { kind: "stageSplit" }> =>
      value.kind === "stageSplit",
  });
  return value.mode === "split" ? { mode: "split", chunks: value.chunks } : { mode: "single" };
}

export async function buildHistoryPrunePlanWithWorker(params: {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  tokensBefore: number;
  contextWindowTokens: number;
  maxHistoryShare: number;
  parts?: number;
  signal?: AbortSignal;
}): Promise<HistoryPrunePlan> {
  const messagesToSummarize = sanitizeCompactionMessages(params.messagesToSummarize);
  const turnPrefixMessages = sanitizeCompactionMessages(params.turnPrefixMessages);
  if (!shouldUsePlanningWorker(messagesToSummarize.length + turnPrefixMessages.length)) {
    return buildHistoryPrunePlan(params);
  }
  const value = await runWithUnavailableFallback({
    input: {
      kind: "historyPrune",
      messagesToSummarize,
      turnPrefixMessages,
      tokensBefore: params.tokensBefore,
      contextWindowTokens: params.contextWindowTokens,
      maxHistoryShare: params.maxHistoryShare,
      parts: params.parts,
    },
    signal: params.signal,
    fallback: () => ({
      kind: "historyPrune" as const,
      ...buildHistoryPrunePlan(params),
    }),
    isExpected: (
      value,
    ): value is Extract<CompactionPlanningWorkerValue, { kind: "historyPrune" }> =>
      value.kind === "historyPrune",
  });
  return {
    summarizableTokens: value.summarizableTokens,
    newContentTokens: value.newContentTokens,
    maxHistoryTokens: value.maxHistoryTokens,
    pruned: value.pruned,
  };
}

export async function computeAdaptiveChunkRatioWithWorker(params: {
  messages: AgentMessage[];
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<number> {
  const messages = sanitizeCompactionMessages(params.messages);
  if (!shouldUsePlanningWorker(messages.length)) {
    return computeAdaptiveChunkRatio(params.messages, params.contextWindow);
  }
  const value = await runWithUnavailableFallback({
    input: {
      kind: "adaptiveChunkRatio",
      messages,
      contextWindow: params.contextWindow,
    },
    signal: params.signal,
    fallback: () => ({
      kind: "adaptiveChunkRatio" as const,
      ratio: computeAdaptiveChunkRatio(params.messages, params.contextWindow),
    }),
    isExpected: (
      value,
    ): value is Extract<CompactionPlanningWorkerValue, { kind: "adaptiveChunkRatio" }> =>
      value.kind === "adaptiveChunkRatio",
  });
  return value.ratio;
}

export const compactionPlanningWorkerTesting = {
  resolveCompactionPlanningWorkerUrl,
  runCompactionPlanningWorker,
  CompactionPlanningWorkerError,
};
