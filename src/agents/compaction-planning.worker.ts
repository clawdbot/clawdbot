/**
 * Worker-thread entrypoint for serializable compaction planning requests.
 */
import { parentPort, workerData } from "node:worker_threads";
import {
  buildOversizedFallbackPlan,
  buildStageSplitPlan,
  buildSummaryChunks,
  computeAdaptiveChunkRatio,
} from "./compaction-planning.js";
import type { AgentMessage } from "./runtime/index.js";

/** Serializable request accepted by the compaction planning worker. */
export type CompactionPlanningWorkerInput =
  | ({ kind: "summaryChunks" } & Parameters<typeof buildSummaryChunks>[0])
  | ({ kind: "oversizedFallback" } & Parameters<typeof buildOversizedFallbackPlan>[0])
  | ({ kind: "stageSplit" } & Parameters<typeof buildStageSplitPlan>[0])
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
  | ({ kind: "stageSplit" } & ({ mode: "single" } | { mode: "split"; chunkIndexes: number[][] }))
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

function isWorkerInput(value: unknown): value is CompactionPlanningWorkerInput {
  if (!value || typeof value !== "object" || !("kind" in value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.messages)) {
    return false;
  }
  switch (input.kind) {
    case "summaryChunks":
    case "stageSplit":
      return typeof input.maxChunkTokens === "number" && Number.isFinite(input.maxChunkTokens);
    case "oversizedFallback":
    case "adaptiveChunkRatio":
      return typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow);
    default:
      return false;
  }
}

function createMessageIndexer(source: AgentMessage[]): (selected: AgentMessage[]) => number[] {
  const indexByMessage = new Map(source.map((message, index) => [message, index]));
  return (selected) =>
    selected.map((message) => {
      const index = indexByMessage.get(message);
      if (index === undefined) {
        throw new Error("Compaction planning result contains an unknown message");
      }
      return index;
    });
}

function planCompactionWorkerInput(
  input: CompactionPlanningWorkerInput,
): CompactionPlanningWorkerValue {
  switch (input.kind) {
    case "summaryChunks":
      return {
        kind: input.kind,
        chunkIndexes: buildSummaryChunks(input).map(createMessageIndexer(input.messages)),
      };
    case "oversizedFallback": {
      const plan = buildOversizedFallbackPlan(input);
      return {
        kind: input.kind,
        smallMessageIndexes: createMessageIndexer(input.messages)(plan.smallMessages),
        oversizedNotes: plan.oversizedNotes,
      };
    }
    case "stageSplit": {
      const plan = buildStageSplitPlan(input);
      return plan.mode === "split"
        ? {
            kind: input.kind,
            mode: "split",
            chunkIndexes: plan.chunks.map(createMessageIndexer(input.messages)),
          }
        : { kind: input.kind, mode: "single" };
    }
    case "adaptiveChunkRatio":
      return {
        kind: input.kind,
        ratio: computeAdaptiveChunkRatio(input.messages, input.contextWindow),
      };
  }
  throw new Error("unsupported compaction planning worker input");
}

/** Run one compaction planning request and return a serializable result. */
export function runCompactionPlanningWorkerInput(input: unknown): CompactionPlanningWorkerResult {
  if (!isWorkerInput(input)) {
    return { status: "failed", error: "invalid compaction planning worker input" };
  }

  try {
    return { status: "ok", value: planCompactionWorkerInput(input) };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

if (parentPort) {
  // Worker-thread mode: process the single workerData payload and post one result.
  const sendToParent: (message: CompactionPlanningWorkerResult) => void =
    parentPort.postMessage.bind(parentPort);
  sendToParent(runCompactionPlanningWorkerInput(workerData));
}
