import {
  createOpenClawCodingToolsForAgentHarness as createCoreOpenClawCodingToolsForAgentHarness,
  createOpenClawCodingToolsForAgentHarnessSideQuestion as createCoreOpenClawCodingToolsForAgentHarnessSideQuestion,
} from "../agents/agent-tools-internal.js";
import type {
  AgentHarnessSideQuestionParams,
  EmbeddedRunAttemptParams,
} from "./agent-harness-runtime.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<typeof import("./agent-harness.js").createOpenClawCodingTools>[0]
>;

/**
 * Build tools for the exact host-admitted attempt without exposing its private
 * execution attribution to plugin code.
 */
export function createOpenClawCodingToolsForAgentHarness(
  attempt: EmbeddedRunAttemptParams,
  options?: OpenClawCodingToolsOptions,
): ReturnType<typeof createCoreOpenClawCodingToolsForAgentHarness> {
  return createCoreOpenClawCodingToolsForAgentHarness(attempt, options);
}

/**
 * Build tools for the exact host-admitted side-question request without
 * exposing its private execution attribution to plugin code.
 */
export function createOpenClawCodingToolsForAgentHarnessSideQuestion(
  params: AgentHarnessSideQuestionParams,
  options?: OpenClawCodingToolsOptions,
): ReturnType<typeof createCoreOpenClawCodingToolsForAgentHarnessSideQuestion> {
  return createCoreOpenClawCodingToolsForAgentHarnessSideQuestion(params, options);
}
