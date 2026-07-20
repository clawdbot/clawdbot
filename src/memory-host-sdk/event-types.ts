import type { MemoryDreamingPhaseName } from "./dreaming.js";

type MemoryHostEventStorageMetadata = {
  /** True when diagnostic detail was bounded before persistence. Aggregate counts stay exact. */
  storageTruncated?: true;
};

/** Event emitted when a recall query records the selected memory snippets. */
type MemoryHostRecallRecordedEvent = MemoryHostEventStorageMetadata & {
  type: "memory.recall.recorded";
  timestamp: string;
  query: string;
  resultCount: number;
  results: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
  }>;
};

/** Event emitted when recall hits are visible but excluded from short-term promotion. */
type MemoryHostRecallSkippedEvent = MemoryHostEventStorageMetadata & {
  type: "memory.recall.skipped";
  timestamp: string;
  query: string;
  reason: "non-short-term-memory-path";
  eligibleResultCount: number;
  skippedResultCount: number;
  results: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    reason: "non-short-term-memory-path";
  }>;
};

/** Event emitted when deep-dream candidates are promoted into durable memory. */
type MemoryHostPromotionAppliedEvent = MemoryHostEventStorageMetadata & {
  type: "memory.promotion.applied";
  timestamp: string;
  memoryPath: string;
  applied: number;
  candidates: Array<{
    key: string;
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    recallCount: number;
  }>;
};

/** Normalized outcome for a dreaming phase run. */
type MemoryDreamOutcome = "completed" | "failed";

/** Event emitted after a dreaming phase writes inline memory and/or reports. */
type MemoryHostDreamCompletedEvent = MemoryHostEventStorageMetadata & {
  type: "memory.dream.completed";
  timestamp: string;
  phase: MemoryDreamingPhaseName;
  /** Missing on older event logs; readers should treat absent as "completed". */
  outcome?: MemoryDreamOutcome;
  /** Error detail when outcome is "failed". */
  error?: string;
  inlinePath?: string;
  reportPath?: string;
  lineCount: number;
  storageMode: "inline" | "separate" | "both";
};

/** Durable memory host events consumed by status and public-artifact readers. */
export type MemoryHostEvent =
  | MemoryHostRecallRecordedEvent
  | MemoryHostPromotionAppliedEvent
  | MemoryHostDreamCompletedEvent;

/** Full event record schema, including opt-in diagnostic variants. */
export type MemoryHostEventRecord = MemoryHostEvent | MemoryHostRecallSkippedEvent;
