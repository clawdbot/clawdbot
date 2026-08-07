import type { AgentExecutionAttribution } from "../../agent-execution-attribution.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const attributionByAttempt = new WeakMap<EmbeddedRunAttemptParams, AgentExecutionAttribution>();

/** Keep host-only execution correlation off the plugin-visible attempt object. */
export function bindEmbeddedAttemptExecutionAttribution(
  attempt: EmbeddedRunAttemptParams,
  attribution: AgentExecutionAttribution | undefined,
): void {
  if (attribution) {
    attributionByAttempt.set(attempt, attribution);
  }
}

export function resolveEmbeddedAttemptExecutionAttribution(
  attempt: EmbeddedRunAttemptParams,
): AgentExecutionAttribution | undefined {
  return attributionByAttempt.get(attempt);
}

/** Preserve host-only attribution when the host rewrites a plugin handoff object. */
export function transferEmbeddedAttemptExecutionAttribution<T extends EmbeddedRunAttemptParams>(
  source: EmbeddedRunAttemptParams,
  target: T,
): T {
  bindEmbeddedAttemptExecutionAttribution(
    target,
    resolveEmbeddedAttemptExecutionAttribution(source),
  );
  return target;
}
