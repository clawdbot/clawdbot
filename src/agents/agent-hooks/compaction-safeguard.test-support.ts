import type { summarizeInStages } from "../compaction.js";
import "./compaction-safeguard.js";

type CompactionSafeguardTestApi = {
  setSummarizeInStagesForTest(next?: typeof summarizeInStages): void;
  collectToolFailures: CallableFunction;
  formatToolFailuresSection: CallableFunction;
  splitPreservedRecentTurns: CallableFunction;
  formatPreservedTurnsSection: CallableFunction;
  formatSplitTurnContextSection: CallableFunction;
  buildCompactionStructureInstructions: CallableFunction;
  buildStructuredFallbackSummary: CallableFunction;
  prependPreviousSummaryForRedistill: CallableFunction;
  appendSummarySection: CallableFunction;
  resolveRecentTurnsPreserve: CallableFunction;
  resolveQualityGuardMaxRetries: CallableFunction;
  extractOpaqueIdentifiers: CallableFunction;
  auditSummaryQuality: CallableFunction;
  capCompactionSummary: CallableFunction;
  capCompactionSummaryPreservingSuffix: CallableFunction;
  formatFileOperations: CallableFunction;
  computeAdaptiveChunkRatio: CallableFunction;
  isOversizedForSummary: CallableFunction;
  readWorkspaceContextForSummary: CallableFunction;
  hasMeaningfulConversationContent: CallableFunction;
  isRealConversationMessage: CallableFunction;
  BASE_CHUNK_RATIO: number;
  MIN_CHUNK_RATIO: number;
  SAFETY_MARGIN: number;
  MAX_COMPACTION_SUMMARY_CHARS: number;
  MAX_FILE_OPS_SECTION_CHARS: number;
  MAX_FILE_OPS_LIST_CHARS: number;
  SUMMARY_TRUNCATED_MARKER: string;
};

function getTestApi(): CompactionSafeguardTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.compactionSafeguardTestApi")
  ];
  if (!api) {
    throw new Error("compaction safeguard test API is unavailable");
  }
  return api as CompactionSafeguardTestApi;
}

export const testing = getTestApi();
