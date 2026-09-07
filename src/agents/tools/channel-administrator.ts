import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  assertChannelAdministratorAuthority,
  mintChannelAdministratorGrant,
} from "../../gateway/channel-administrator-authority.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

/** Bind every privileged RPC to its captured host run, never to tool arguments. */
export function prepareChannelAdministratorRequest(
  method: string,
  signal?: AbortSignal,
  runtimeIdentity?: AgentRuntimeIdentity,
): { identity: AgentRuntimeIdentity; assertCurrent: () => void } | undefined {
  // Approval registration owns a narrower, request-lifetime claim. It does not
  // need administrator scope and must keep the existing approval policy/lease.
  if (method === "exec.approval.request" || method === "plugin.approval.request") {
    return undefined;
  }
  const caller = getGatewayToolCallerIdentity();
  const capability = caller?.channelAdministrator;
  if (!capability) {
    return undefined;
  }
  const authority = caller.approvalAuthority;
  const gateway = caller.gatewayContextResolver?.();
  if (
    !authority ||
    !gateway ||
    !caller.receiptAuthority ||
    caller.signedAgentRuntimeIdentityToken
  ) {
    throw new Error(
      "Trusted channel administration requires its admitting Gateway and live run authority.",
    );
  }
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (
      caller.approvalSignals?.some((item) => item.aborted) ||
      caller.receiptAuthority?.() === false ||
      caller.gatewayContextResolver?.() !== gateway
    ) {
      throw new Error("Trusted channel administrator run is no longer active.");
    }
    assertChannelAdministratorAuthority(capability, authority);
  };
  assertCurrent();
  const identity: AgentRuntimeIdentity = runtimeIdentity ?? {
    kind: "agentRuntime",
    agentId: caller.agentId,
    sessionKey: caller.sessionKey,
    operationalRunInstance: authority.operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
    executionIdentity: caller.executionIdentityToken,
    turnSourceChannel: caller.turnSourceChannel,
    turnSourceTo: caller.turnSourceTo,
    turnSourceAccountId: caller.turnSourceAccountId,
    turnSourceThreadId: caller.turnSourceThreadId,
    cronCreatorAuthorityGrant: caller.cronCreatorAuthorityGrant,
    cronToolsAllowCapture: caller.cronToolsAllowCapture,
    cronExecToolTarget: caller.cronExecToolTarget,
  };
  if (
    identity.operationalRunInstance.instanceId !== authority.operationalRunInstance.instanceId ||
    identity.operationalRunInstance.runId !== authority.operationalRunInstance.runId ||
    identity.delegatedAuthority.claimId !== authority.claimId ||
    identity.delegatedAuthority.lifecycleGeneration !== authority.lifecycleGeneration
  ) {
    throw new Error("Trusted channel administrator identity does not match the admitted run.");
  }
  return {
    identity: {
      ...identity,
      channelAdministratorGrant: mintChannelAdministratorGrant(
        capability,
        authority,
        method,
        signal,
      ),
    },
    assertCurrent,
  };
}
