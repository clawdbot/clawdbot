import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import * as execHostShared from "./bash-tools.exec-host-shared.js";

export type NodeGatewayDispatchAuthority =
  | "current-policy"
  | "human-approval"
  | "auto-review"
  | "ask-fallback";

export type NodeGatewayPolicyCheckpoint = {
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ExecSecurity;
};

export async function assertCurrentNodeGatewayPolicyAllowsDispatch(params: {
  request: ExecuteNodeHostCommandParams;
  authority: NodeGatewayDispatchAuthority;
  currentPolicyAllows?: (policy: { hostSecurity: ExecSecurity; hostAsk: ExecAsk }) => boolean;
  fallbackPolicy?: NodeGatewayPolicyCheckpoint;
}): Promise<void> {
  const current = await execHostShared.resolveExecHostApprovalContext({
    agentId: params.request.agentId,
    security: params.request.security,
    ask: params.request.ask,
    host: "node",
  });
  // A human grant may bypass ask/allowlist, but never a later deny. Auto-review
  // additionally cannot stand in for a newly required human decision.
  if (current.hostSecurity === "deny") {
    throw new Error("exec denied: host=node security=deny");
  }
  if (params.authority === "human-approval") {
    return;
  }
  if (params.authority === "auto-review") {
    if (current.hostAsk === "always") {
      throw new Error("exec denied: host=node ask=always requires human approval");
    }
    return;
  }
  if (params.authority === "ask-fallback") {
    const expected = params.fallbackPolicy;
    if (
      !expected ||
      current.hostSecurity !== expected.hostSecurity ||
      current.hostAsk !== expected.hostAsk ||
      current.askFallback !== expected.askFallback
    ) {
      throw new Error("exec denied: host=node fallback policy changed before dispatch");
    }
    return;
  }
  if (!params.currentPolicyAllows?.(current)) {
    throw new Error("exec denied: host=node policy changed before dispatch");
  }
}
