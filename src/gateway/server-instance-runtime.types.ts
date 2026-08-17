import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";

export type GatewayApprovalEventPublisher = {
  publishRequested: (kind: ChannelApprovalKind, request: unknown) => number;
  publishResolved: (kind: ChannelApprovalKind, resolved: unknown) => void;
};

export type GatewayRecoveryRuntime = {
  dispatchAgent: <T = unknown>(
    params: AgentRunRequest,
    timeoutMs?: number,
    options?: { allowModelOverride?: boolean; scopes?: string[] },
  ) => Promise<T>;
  waitForAgent: <T = unknown>(params: AgentWaitParams, timeoutMs?: number) => Promise<T>;
  sendRecoveryNotice: (params: {
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
    text: string;
    idempotencyKey: string;
  }) => Promise<{
    /** True when delivery produced zero platform results (policy/channel suppression). */
    suppressed: boolean;
  }>;
};

export type GatewayInstanceRuntime = {
  approvalEvents: GatewayApprovalEventPublisher;
  nativeApprovals: GatewayNativeApprovalRuntime;
  recovery: GatewayRecoveryRuntime;
  close: () => void;
};
