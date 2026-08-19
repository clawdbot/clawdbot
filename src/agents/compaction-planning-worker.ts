import {
  CompactionPlanningWorkerError,
  runCompactionPlanningWorker,
} from "./compaction-planning-worker-runtime.js";
/**
 * Runs CPU-heavy compaction planning in a worker thread when histories are
 * large enough to risk starving the main event loop.
 */
import {
  buildOversizedFallbackPlan,
  buildStageSplitPlan,
  buildSummaryChunks,
  computeAdaptiveChunkRatio,
  projectCompactionMessagesForPlanning,
  sanitizeCompactionMessages,
  type OversizedFallbackPlan,
  type StageSplitPlan,
} from "./compaction-planning.js";
import type {
  CompactionPlanningWorkerInput,
  CompactionPlanningWorkerValue,
} from "./compaction-planning.worker.js";
import type { AgentMessage } from "./runtime/index.js";

// Worker startup is more expensive than local planning for tiny histories.
// Keep small compactions synchronous; move only starvation-sized plans off-thread.
const COMPACTION_PLANNING_WORKER_MIN_MESSAGES = 64;

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

async function runCompactionPlan<TInput extends CompactionPlanningWorkerInput, TResult>(params: {
  input: TInput;
  signal?: AbortSignal;
  fallback: (messages: AgentMessage[]) => TResult;
  restore: (
    value: Extract<CompactionPlanningWorkerValue, { kind: TInput["kind"] }>,
    messages: AgentMessage[],
  ) => TResult;
}): Promise<TResult> {
  const messages = sanitizeCompactionMessages(params.input.messages);
  if (messages.length < COMPACTION_PLANNING_WORKER_MIN_MESSAGES) {
    return params.fallback(params.input.messages);
  }

  try {
    const value = await runCompactionPlanningWorker({
      input: {
        ...params.input,
        messages: projectCompactionMessagesForPlanning(messages),
      },
      signal: params.signal,
    });
    if (value.kind !== params.input.kind) {
      throw new CompactionPlanningWorkerError(
        "unexpected compaction planning worker result",
        "failed",
      );
    }
    return params.restore(
      value as Extract<CompactionPlanningWorkerValue, { kind: TInput["kind"] }>,
      messages,
    );
  } catch (error) {
    if (error instanceof CompactionPlanningWorkerError && error.code === "unavailable") {
      return params.fallback(messages);
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
  const { signal, ...planningInput } = params;
  return runCompactionPlan({
    input: { kind: "summaryChunks", ...planningInput },
    signal,
    fallback: (messages) => buildSummaryChunks({ ...planningInput, messages }),
    restore: (value, messages) =>
      value.chunkIndexes.map((indexes) => restoreIndexedMessages(messages, indexes)),
  });
}

/** Builds an oversized-message fallback plan, using the worker when worthwhile. */
export async function buildOversizedFallbackPlanWithWorker(params: {
  messages: AgentMessage[];
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<OversizedFallbackPlan> {
  const { signal, ...planningInput } = params;
  return runCompactionPlan({
    input: { kind: "oversizedFallback", ...planningInput },
    signal,
    fallback: (messages) => buildOversizedFallbackPlan({ ...planningInput, messages }),
    restore: (value, messages) => ({
      smallMessages: restoreIndexedMessages(messages, value.smallMessageIndexes),
      oversizedNotes: value.oversizedNotes,
    }),
  });
}

/** Builds a staged summarization split plan with worker fallback. */
export async function buildStageSplitPlanWithWorker(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
  parts?: number;
  minMessagesForSplit?: number;
  signal?: AbortSignal;
}): Promise<StageSplitPlan> {
  const { signal, ...planningInput } = params;
  return runCompactionPlan({
    input: { kind: "stageSplit", ...planningInput },
    signal,
    fallback: (messages) => buildStageSplitPlan({ ...planningInput, messages }),
    restore: (value, messages) =>
      value.mode === "split"
        ? {
            mode: "split",
            chunks: value.chunkIndexes.map((indexes) => restoreIndexedMessages(messages, indexes)),
          }
        : { mode: "single" },
  });
}

/** Computes the adaptive compaction chunk ratio with worker fallback. */
export async function computeAdaptiveChunkRatioWithWorker(params: {
  messages: AgentMessage[];
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<number> {
  const { signal, ...planningInput } = params;
  return runCompactionPlan({
    input: { kind: "adaptiveChunkRatio", ...planningInput },
    signal,
    fallback: () => computeAdaptiveChunkRatio(planningInput.messages, planningInput.contextWindow),
    restore: (value) => value.ratio,
  });
}
