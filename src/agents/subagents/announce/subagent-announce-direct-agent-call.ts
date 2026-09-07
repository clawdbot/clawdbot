/**
 * Timeout-bounded agent dispatch used by direct subagent announce delivery.
 */
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../../sessions/input-provenance.js";
import { SourceOwnerChangedError } from "./subagent-announce-delivery-retry.js";
import { dispatchSubagentAnnounceAgent } from "./subagent-announce-delivery.runtime.js";
import type { SubagentCompletionToolHandoffRegistration } from "./subagent-announce-handoff.js";

export async function runAnnounceAgentCall(params: {
  agentParams: Record<string, unknown>;
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  expectFinal?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  isExecutionAllowed: () => boolean;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
}): Promise<unknown> {
  const deadline = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline.signal])
    : deadline.signal;
  const timer =
    params.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => deadline.abort(new Error("gateway request timeout for agent")),
          params.timeoutMs,
        );
  timer?.unref?.();
  try {
    return await dispatchSubagentAnnounceAgent(params.agentParams, {
      cancelOnDeadline: true,
      expectFinal: params.expectFinal,
      forceSyntheticClient: shouldPreserveUserFacingSessionStateForInputProvenance(
        params.agentParams.inputProvenance,
      ),
      operatorRoleActor: { kind: "system" },
      delegatedToolPolicyHandoff: params.delegatedToolPolicyHandoff,
      signal,
      // Accepted queue waits belong to session admission; execution belongs to
      // the requester runtime budget, not the announcement handoff deadline.
      onAccepted: () => clearTimeout(timer),
      onExecutionStarted: () => {
        signal.throwIfAborted();
        if (!params.isExecutionAllowed()) {
          throw new SourceOwnerChangedError();
        }
        // Execution can be observed before acceptance on an already-running replay.
        clearTimeout(timer);
      },
      resolveGatewayContext: params.resolveGatewayContext,
    });
  } finally {
    clearTimeout(timer);
  }
}
