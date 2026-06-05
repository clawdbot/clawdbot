/**
 * Reconciles orphaned trailing user prompts before provider submission.
 */
import { mergeOrphanedTrailingUserPrompt } from "./attempt.prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Inputs required to reconcile an active session leaf with the prompt about to be sent. */
export type OrphanedTrailingUserPromptMergeParams = {
  prompt: string;
  trigger: EmbeddedRunAttemptParams["trigger"];
  leafMessage: { content?: unknown };
};

/** Result of merging or dropping a trailing user leaf before provider submission. */
export type OrphanedTrailingUserPromptMergeResult = {
  prompt: string;
  merged: boolean;
  /**
   * When false, the active session leaf is preserved. Use this only when the
   * caller intentionally accepts that the next appended prompt may follow an
   * existing user leaf; most providers reject consecutive user turns.
   */
  removeLeaf: boolean;
};

/** Registry id for the transcript message merge behavior currently supported by embedded runs. */
export type MessageMergeStrategyId = "orphan-trailing-user-prompt";

/** Strategy seam for tests and future runtime variants that alter prompt/leaf reconciliation. */
export type MessageMergeStrategy = {
  id: MessageMergeStrategyId;
  mergeOrphanedTrailingUserPrompt: (
    params: OrphanedTrailingUserPromptMergeParams,
  ) => OrphanedTrailingUserPromptMergeResult;
};

/** Default strategy used by embedded attempts when no test override is installed. */
export const DEFAULT_MESSAGE_MERGE_STRATEGY_ID: MessageMergeStrategyId =
  "orphan-trailing-user-prompt";

const defaultMessageMergeStrategy: MessageMergeStrategy = {
  id: DEFAULT_MESSAGE_MERGE_STRATEGY_ID,
  mergeOrphanedTrailingUserPrompt,
};

let activeMessageMergeStrategy = defaultMessageMergeStrategy;

/** Returns the active merge strategy for the current process. */
export function resolveMessageMergeStrategy(): MessageMergeStrategy {
  return activeMessageMergeStrategy;
}

function registerMessageMergeStrategy(strategy: MessageMergeStrategy): () => void {
  const previous = activeMessageMergeStrategy;
  activeMessageMergeStrategy = strategy;
  return () => {
    activeMessageMergeStrategy = previous;
  };
}

/** Installs a process-local merge strategy override and returns a restore callback. */
export function registerMessageMergeStrategyForTest(strategy: MessageMergeStrategy): () => void {
  return registerMessageMergeStrategy(strategy);
}
