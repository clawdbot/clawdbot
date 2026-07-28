// Public agent-core package surface: agent loop, compaction, session context,
// and the focused helpers consumed by OpenClaw.
export * from "./agent.js";
export * from "./agent-loop.js";
export * from "./errors.js";
export * from "./runtime-deps.js";
export * from "./types.js";
export * from "./validation.js";
export * from "./harness/env/kill-tree.js";
export * from "./harness/messages.js";
export * from "./harness/prompt-template-arguments.js";
export { buildSessionContext } from "./harness/session/session.js";
export { uuidv7 } from "./harness/session/uuid.js";
export type {
  BranchSummaryResult,
  FileOperations,
  Result,
  SessionTreeEntry,
} from "./harness/types.js";
export {
  type BranchPreparation,
  type BranchPathEntry,
  type BranchSummaryDetails,
  type CollectBranchPathEntriesResult,
  collectEntriesForBranchSummaryFromBranches,
  generateBranchSummary,
  prepareBranchEntries,
} from "./harness/compaction/branch-summarization.js";
export {
  calculateContextTokens,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateSummary,
  getLastAssistantUsage,
  prepareCompaction,
  serializeConversation,
  shouldCompact,
  type CompactionDetails,
  type CompactionPreparation,
  type CompactionResult,
  type CompactionSettings,
  type ContextUsageEstimate,
} from "./harness/compaction/compaction.js";
export * from "./harness/utils/truncate.js";
