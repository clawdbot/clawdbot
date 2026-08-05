import type { InputProvenance } from "../sessions/input-provenance.js";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "./internal-event-contract.js";
import type { AgentInternalEvent } from "./internal-events.js";

export type TrustedSubagentCompletionHandoff = {
  kind: "subagent-completion";
  sourceSessionKey: string;
  sourceSessionId?: string;
  targetSessionKey: string;
  targetSessionId: string;
  provider: string;
  model: string;
};

export type SubagentCompletionToolHandoffRegistration = {
  sourceSessionKey: string;
  sourceSessionId?: string;
  targetSessionKey: string;
  targetSessionId: string;
  idempotencyKey: string;
};

export function resolveExactSubagentCompletionEvent(params: {
  inputProvenance?: InputProvenance;
  internalEvents?: AgentInternalEvent[];
}) {
  if (
    params.inputProvenance?.kind !== "inter_session" ||
    params.inputProvenance.sourceTool !== "subagent_announce"
  ) {
    return undefined;
  }
  const completionEvents = params.internalEvents?.filter(
    (event) =>
      event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION && event.source === "subagent",
  );
  const completionEvent = completionEvents?.length === 1 ? completionEvents[0] : undefined;
  return completionEvent?.childSessionKey === params.inputProvenance.sourceSessionKey
    ? completionEvent
    : undefined;
}

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

/** Verify that a consumed in-process handoff still matches this exact model attempt. */
export function isTrustedSubagentCompletionHandoffForRun(params: {
  handoff?: TrustedSubagentCompletionHandoff;
  inputProvenance?: InputProvenance;
  internalEvents?: AgentInternalEvent[];
  sessionKey?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
}): boolean {
  const handoff = params.handoff;
  const completionEvent = resolveExactSubagentCompletionEvent({
    inputProvenance: params.inputProvenance,
    internalEvents: params.internalEvents,
  });
  if (
    !handoff ||
    handoff.kind !== "subagent-completion" ||
    params.inputProvenance?.kind !== "inter_session" ||
    params.inputProvenance.sourceTool !== "subagent_announce" ||
    (params.internalEvents !== undefined && !completionEvent)
  ) {
    return false;
  }
  return (
    handoff.sourceSessionKey === params.inputProvenance.sourceSessionKey &&
    (params.internalEvents === undefined ||
      handoff.sourceSessionId === completionEvent?.childSessionId) &&
    handoff.targetSessionKey === params.sessionKey &&
    handoff.targetSessionId === params.sessionId &&
    handoff.provider === params.provider?.trim().toLowerCase() &&
    handoff.model === params.model?.trim()
  );
}
