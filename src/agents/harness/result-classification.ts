import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "./types.js";

export function applyAgentHarnessResultClassification(
  harness: Pick<AgentHarness, "id" | "classify">,
  result: AgentHarnessAttemptResult,
  params: AgentHarnessAttemptParams,
): AgentHarnessAttemptResult {
  if (!harness.classify) {
    return { ...result, agentHarnessId: harness.id };
  }
  const { agentHarnessResultClassification: _previousClassification, ...resultWithoutPrevious } =
    result;
  const classification = harness.classify(resultWithoutPrevious, params);
  if (!classification || classification === "ok") {
    return { ...resultWithoutPrevious, agentHarnessId: harness.id };
  }
  return {
    ...resultWithoutPrevious,
    agentHarnessId: harness.id,
    agentHarnessResultClassification: classification,
  };
}
