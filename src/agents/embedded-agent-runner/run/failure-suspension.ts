/**
 * Builds the suspension request for an embedded run failure.
 *
 * The run owns the canonical agent id; failure callers only carry agentDir,
 * which cannot identify the owner of an unregistered or shared directory.
 */
import type { SessionSuspensionParams } from "../../session-suspension.js";

export function buildEmbeddedFailureSuspension(params: {
  suspension: SessionSuspensionParams;
  runAgentId?: string;
}): SessionSuspensionParams {
  return {
    ...params.suspension,
    // A caller-supplied id wins; the run id only fills the gap so an
    // unregistered agentDir cannot fall back to the default agent's store.
    agentId: params.suspension.agentId ?? params.runAgentId,
  };
}
