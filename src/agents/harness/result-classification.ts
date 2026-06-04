/**
 * Agent harness result classification helper.
 *
 * Harness lifecycle wraps raw attempt results with harness id metadata and lets
 * harness-specific classifiers attach non-ok result categories.
 */
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "./types.js";

/** Applies a harness classifier while replacing any stale prior classification. */
export function applyAgentHarnessResultClassification(
  harness: Pick<AgentHarness, "id" | "classify">,
  result: AgentHarnessAttemptResult,
  params: AgentHarnessAttemptParams,
): AgentHarnessAttemptResult {
  if (!harness.classify) {
    return { ...result, agentHarnessId: harness.id };
  }
  // Reclassify from the raw result so retries or wrappers cannot preserve an
  // obsolete classification from an earlier harness.
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
