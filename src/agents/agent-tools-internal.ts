import { createOpenClawCodingTools, createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { resolveEmbeddedAttemptExecutionAttribution } from "./embedded-agent-runner/run/attempt-execution-attribution.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { resolveAgentHarnessSideQuestionExecutionAttribution } from "./harness/side-question-execution-attribution.js";
import type { AgentHarnessSideQuestionParams } from "./harness/types.js";

type OpenClawCodingToolsInternalOptions = NonNullable<
  Parameters<typeof createOpenClawCodingToolsInternal>[0]
>;
type OpenClawCodingToolsOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;

function stripUntrustedAttribution(
  options: OpenClawCodingToolsOptions | undefined,
): OpenClawCodingToolsOptions {
  const { attribution: _untrustedAttribution, ...publicOptions } = (options ??
    {}) as OpenClawCodingToolsInternalOptions;
  return publicOptions;
}

export function createOpenClawCodingToolsForRuntime(
  options?: OpenClawCodingToolsInternalOptions,
): ReturnType<typeof createOpenClawCodingToolsInternal> {
  return createOpenClawCodingToolsInternal(options);
}

/**
 * Construct tools for a core-admitted harness attempt. The attempt object is
 * the capability: unbound plugin-created objects receive no trusted identity.
 */
export function createOpenClawCodingToolsForAgentHarness(
  attempt: EmbeddedRunAttemptParams,
  options?: OpenClawCodingToolsOptions,
): ReturnType<typeof createOpenClawCodingToolsInternal> {
  const attribution = resolveEmbeddedAttemptExecutionAttribution(attempt);
  return createOpenClawCodingToolsInternal({
    ...stripUntrustedAttribution(options),
    ...(attribution ? { attribution } : {}),
  });
}

/**
 * Construct tools for the exact host-admitted side-question request. The
 * public request object is the capability; its fields contain no attribution.
 */
export function createOpenClawCodingToolsForAgentHarnessSideQuestion(
  params: AgentHarnessSideQuestionParams,
  options?: OpenClawCodingToolsOptions,
): ReturnType<typeof createOpenClawCodingToolsInternal> {
  const attribution = resolveAgentHarnessSideQuestionExecutionAttribution(params);
  return createOpenClawCodingToolsInternal({
    ...stripUntrustedAttribution(options),
    ...(attribution ? { attribution } : {}),
  });
}
