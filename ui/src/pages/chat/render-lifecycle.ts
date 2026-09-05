type CancelAfterCommit = () => void;
type CompleteAfterCommit = () => void;
export type AfterCommitEffect = (complete: CompleteAfterCommit) => CancelAfterCommit | void;

/**
 * Renderer-neutral boundary for state invalidation and DOM-dependent effects.
 * `afterCommit` must request a render before waiting for its commit.
 */
export interface RenderLifecycle {
  invalidate(): void;
  /**
   * Run after the next commit. Async follow-up work returns its cleanup and
   * calls `complete` when done so the lifecycle owns it through teardown.
   */
  afterCommit(effect: AfterCommitEffect, onCancel?: () => void): CancelAfterCommit;
}
