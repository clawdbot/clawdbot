import type { InputProvenance } from "../sessions/input-provenance.js";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "./internal-event-contract.js";
import type { AgentInternalEvent } from "./internal-events.js";

/** Identifies the delivery-only turn that hands a completed subagent result to its requester. */
export function isSubagentAnnounceCompletionHandoff(params: {
  inputProvenance?: InputProvenance;
  internalEvents?: AgentInternalEvent[];
}): boolean {
  if (
    params.inputProvenance?.kind !== "inter_session" ||
    params.inputProvenance.sourceTool !== "subagent_announce"
  ) {
    return false;
  }
  return (
    params.internalEvents?.some(
      (event) =>
        event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION && event.source === "subagent",
    ) === true
  );
}
