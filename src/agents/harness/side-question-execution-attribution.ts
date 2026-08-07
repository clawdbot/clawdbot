import type { AgentExecutionAttribution } from "../agent-execution-attribution.js";
import type { AgentHarnessSideQuestionParams } from "./types.js";

const attributionBySideQuestion = new WeakMap<
  AgentHarnessSideQuestionParams,
  AgentExecutionAttribution
>();

/**
 * Bind host attribution to the exact side-question request handed to a harness.
 * Clones and plugin-created request objects intentionally receive no identity.
 */
export function bindAgentHarnessSideQuestionExecutionAttribution(
  params: AgentHarnessSideQuestionParams,
  attribution: AgentExecutionAttribution | undefined,
): AgentHarnessSideQuestionParams {
  if (attribution) {
    attributionBySideQuestion.set(params, attribution);
  }
  return params;
}

export function resolveAgentHarnessSideQuestionExecutionAttribution(
  params: AgentHarnessSideQuestionParams,
): AgentExecutionAttribution | undefined {
  return attributionBySideQuestion.get(params);
}
