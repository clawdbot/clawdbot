/**
 * Worker-thread entrypoint for serializable compaction planning requests.
 */
import { parentPort, workerData } from "node:worker_threads";
import {
  buildHistoryPrunePlan,
  buildOversizedFallbackPlan,
  buildStageSplitPlan,
  buildSummaryChunks,
  computeAdaptiveChunkRatio,
  type HistoryPrunePlan,
} from "./compaction-planning.js";
import type { AgentMessage } from "./runtime/index.js";

/** Serializable request accepted by the compaction planning worker. */
export type CompactionPlanningWorkerInput =
  | {
      kind: "summaryChunks";
      messages: AgentMessage[];
      maxChunkTokens: number;
    }
  | {
      kind: "oversizedFallback";
      messages: AgentMessage[];
      contextWindow: number;
    }
  | {
      kind: "stageSplit";
      messages: AgentMessage[];
      maxChunkTokens: number;
      parts?: number;
      minMessagesForSplit?: number;
    }
  | {
      kind: "historyPrune";
      messagesToSummarize: AgentMessage[];
      turnPrefixMessages: AgentMessage[];
      tokensBefore: number;
      contextWindowTokens: number;
      maxHistoryShare: number;
      parts?: number;
    }
  | {
      kind: "adaptiveChunkRatio";
      messages: AgentMessage[];
      contextWindow: number;
    };

/** Serializable successful value returned by the compaction planning worker. */
export type CompactionPlanningWorkerValue =
  | {
      kind: "summaryChunks";
      chunkIndexes: number[][];
    }
  | {
      kind: "oversizedFallback";
      smallMessageIndexes: number[];
      oversizedNotes: string[];
    }
  | {
      kind: "stageSplit";
      mode: "single";
    }
  | {
      kind: "stageSplit";
      mode: "split";
      chunkIndexes: number[][];
    }
  | ({
      kind: "historyPrune";
    } & HistoryPrunePlan)
  | {
      kind: "adaptiveChunkRatio";
      ratio: number;
    };

/** Serializable success/failure envelope posted by the worker. */
export type CompactionPlanningWorkerResult =
  | {
      status: "ok";
      value: CompactionPlanningWorkerValue;
    }
  | {
      status: "failed";
      error: string;
    };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMessageArray(value: unknown): value is AgentMessage[] {
  return Array.isArray(value);
}

function isWorkerInput(value: unknown): value is CompactionPlanningWorkerInput {
  if (!value || typeof value !== "object" || !("kind" in value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  switch (input.kind) {
    case "summaryChunks":
      return isMessageArray(input.messages) && isFiniteNumber(input.maxChunkTokens);
    case "oversizedFallback":
      return isMessageArray(input.messages) && isFiniteNumber(input.contextWindow);
    case "stageSplit":
      return isMessageArray(input.messages) && isFiniteNumber(input.maxChunkTokens);
    case "historyPrune":
      return (
        isMessageArray(input.messagesToSummarize) &&
        isMessageArray(input.turnPrefixMessages) &&
        isFiniteNumber(input.tokensBefore) &&
        isFiniteNumber(input.contextWindowTokens) &&
        isFiniteNumber(input.maxHistoryShare)
      );
    case "adaptiveChunkRatio":
      return isMessageArray(input.messages) && isFiniteNumber(input.contextWindow);
    default:
      return false;
  }
}

function indexSelectedMessages(
  indexByMessage: ReadonlyMap<AgentMessage, number>,
  selected: AgentMessage[],
): number[] {
  return selected.map((message) => {
    const index = indexByMessage.get(message);
    if (index === undefined) {
      throw new Error("Compaction planning result contains an unknown message");
    }
    return index;
  });
}

function indexMessageChunks(source: AgentMessage[], chunks: AgentMessage[][]): number[][] {
  const indexByMessage = new Map(source.map((message, index) => [message, index]));
  return chunks.map((chunk) => indexSelectedMessages(indexByMessage, chunk));
}

/** Run one compaction planning request and return a serializable result. */
export function runCompactionPlanningWorkerInput(input: unknown): CompactionPlanningWorkerResult {
  if (!isWorkerInput(input)) {
    return {
      status: "failed",
      error: "invalid compaction planning worker input",
    };
  }

  try {
    switch (input.kind) {
      case "summaryChunks": {
        const chunks = buildSummaryChunks(input);
        return {
          status: "ok",
          value: {
            kind: "summaryChunks",
            chunkIndexes: indexMessageChunks(input.messages, chunks),
          },
        };
      }
      case "oversizedFallback": {
        const plan = buildOversizedFallbackPlan(input);
        const indexByMessage = new Map(input.messages.map((message, index) => [message, index]));
        return {
          status: "ok",
          value: {
            kind: "oversizedFallback",
            smallMessageIndexes: indexSelectedMessages(indexByMessage, plan.smallMessages),
            oversizedNotes: plan.oversizedNotes,
          },
        };
      }
      case "stageSplit": {
        const plan = buildStageSplitPlan(input);
        return {
          status: "ok",
          value:
            plan.mode === "split"
              ? {
                  kind: "stageSplit",
                  mode: "split",
                  chunkIndexes: indexMessageChunks(input.messages, plan.chunks),
                }
              : { kind: "stageSplit", mode: "single" },
        };
      }
      case "historyPrune":
        return {
          status: "ok",
          value: {
            kind: "historyPrune",
            ...buildHistoryPrunePlan(input),
          },
        };
      case "adaptiveChunkRatio":
        return {
          status: "ok",
          value: {
            kind: "adaptiveChunkRatio",
            ratio: computeAdaptiveChunkRatio(input.messages, input.contextWindow),
          },
        };
    }

    return {
      status: "failed",
      error: "unsupported compaction planning worker input",
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

if (parentPort) {
  // Worker-thread mode: process the single workerData payload and post one result.
  const sendToParent: (message: CompactionPlanningWorkerResult) => void =
    parentPort.postMessage.bind(parentPort);
  sendToParent(runCompactionPlanningWorkerInput(workerData));
}
