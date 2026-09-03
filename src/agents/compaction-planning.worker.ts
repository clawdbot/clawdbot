/**
 * Worker-thread entrypoint for serializable compaction planning requests.
 */
import { serveWorkerTasks } from "../infra/worker-task-pool.js";
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

/** Run one compaction planning request and return a serializable value. */
export function runCompactionPlanningWorkerInput(input: unknown): CompactionPlanningWorkerValue {
  if (!isWorkerInput(input)) {
    throw new Error("invalid compaction planning worker input");
  }
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

serveWorkerTasks(runCompactionPlanningWorkerInput);
