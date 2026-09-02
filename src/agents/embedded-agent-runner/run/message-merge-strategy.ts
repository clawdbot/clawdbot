/**
 * Reconciles orphaned trailing user prompts before provider submission.
 */
import { mergeOrphanedTrailingUserPrompt } from "./attempt-prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Inputs required to reconcile an active session leaf with the prompt about to be sent. */
type OrphanedTrailingUserPromptMergeParams = {
  prompt: string;
  trigger: EmbeddedRunAttemptParams["trigger"];
  leafMessage: { content?: unknown; provenance?: unknown };
  /** Restart-recovery only: keep the interrupted external user leaf durable. */
  preserveTrailingUserLeaf?: boolean;
};

/** Result of merging or dropping a trailing user leaf before provider submission. */
type OrphanedTrailingUserPromptMergeResult = {
  prompt: string;
  merged: boolean;
  /**
   * When false, the active session leaf is preserved. Restart recovery only
   * (`preserveTrailingUserLeaf`); ordinary orphans should detach so the next
   * prompt is not a second durable user row under a preserved leaf.
   */
  removeLeaf: boolean;
};

/** Registry id for the transcript message merge behavior currently supported by embedded runs. */
type MessageMergeStrategyId = "orphan-trailing-user-prompt";

/** Strategy seam for tests and future runtime variants that alter prompt/leaf reconciliation. */
export type MessageMergeStrategy = {
  id: MessageMergeStrategyId;
  mergeOrphanedTrailingUserPrompt: (
    params: OrphanedTrailingUserPromptMergeParams,
  ) => OrphanedTrailingUserPromptMergeResult;
};

/** Strategy used by embedded attempts. */
const DEFAULT_MESSAGE_MERGE_STRATEGY_ID: MessageMergeStrategyId = "orphan-trailing-user-prompt";

const defaultMessageMergeStrategy: MessageMergeStrategy = {
  id: DEFAULT_MESSAGE_MERGE_STRATEGY_ID,
  mergeOrphanedTrailingUserPrompt,
};

/** Returns the transcript merge strategy used by embedded attempts. */
export function resolveMessageMergeStrategy(): MessageMergeStrategy {
  return defaultMessageMergeStrategy;
}
