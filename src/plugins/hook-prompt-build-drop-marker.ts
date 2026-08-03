/**
 * In-prompt markers for dropped `before_prompt_build` contributions.
 *
 * The runtime is fail-open around prompt-build hooks: a re-entrant dispatch, a
 * throwing handler, and a handler that exceeds its timeout all end with the
 * contribution discarded. Logging alone leaves the assembled prompt looking
 * complete, so the agent reasons over a context whose injected work queue is
 * silently absent. The marker replaces the lost contribution in the prompt so
 * the loss is a visible fact rather than an inference.
 */

/** Closed set of reasons a prompt-build contribution can be discarded. */
export type PromptBuildDropReason = "reentrant" | "failed" | "timed-out";

const PROMPT_BUILD_DROP_REASON_TEXT: Record<PromptBuildDropReason, string> = {
  reentrant: "re-entrant dispatch",
  failed: "handler failed",
  "timed-out": "handler timed out",
};

/**
 * Terse failure signal, not a report: one line naming the lost source and why.
 * `pluginId` is omitted for `reentrant`, which skips every handler at once and
 * therefore has no single owner to name.
 */
export function buildPromptBuildDropMarker(params: {
  reason: PromptBuildDropReason;
  pluginId?: string;
}): string {
  const source = params.pluginId ? ` from plugin "${params.pluginId}"` : "";
  return (
    `[context-lost] before_prompt_build contribution${source} was dropped ` +
    `(${PROMPT_BUILD_DROP_REASON_TEXT[params.reason]}); this prompt is missing it.`
  );
}
