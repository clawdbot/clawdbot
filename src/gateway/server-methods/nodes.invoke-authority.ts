import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type ForwardedNodeInvokeApprovalAuthority = {
  recordId: string;
  decision: Extract<ExecApprovalDecision, "allow-once" | "allow-always">;
};

export function isForwardedNodeInvokeApprovalAuthorityActive(params: {
  manager?: Pick<ExecApprovalManager, "projectDecisionIfActive">;
  authority?: ForwardedNodeInvokeApprovalAuthority;
}): boolean {
  const authority = params.authority;
  return (
    !authority ||
    params.manager?.projectDecisionIfActive(authority.recordId, authority.decision) ===
      authority.decision
  );
}

export function resolveNodeInvokeRuntimeAuthorityError(params: {
  context: Pick<
    GatewayRequestContext,
    "execApprovalManager" | "validateAgentRuntimeApprovalAuthority"
  >;
  client: GatewayClient | null;
  approvalAuthority?: ForwardedNodeInvokeApprovalAuthority;
}): string | undefined {
  const callerIdentity = params.client?.internal?.agentRuntimeIdentity;
  if (
    callerIdentity &&
    params.context.validateAgentRuntimeApprovalAuthority?.(callerIdentity) !== true
  ) {
    return "agent runtime approval authority closed before node dispatch";
  }
  if (
    !isForwardedNodeInvokeApprovalAuthorityActive({
      manager: params.context.execApprovalManager,
      authority: params.approvalAuthority,
    })
  ) {
    return "approved runtime authority closed before node dispatch";
  }
  return undefined;
}
