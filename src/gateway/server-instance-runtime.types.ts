import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import type { SubagentCompletionToolHandoffRegistration } from "../agents/subagents/announce/subagent-announce-handoff.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

export type GatewayInstanceAgentDispatchOptions = {
  allowModelOverride?: boolean;
  allowSyntheticModelOverride?: boolean;
  allowSyntheticCronRunContinuation?: boolean;
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  expectFinal?: boolean;
  /** Instance-owned dispatch always uses a synthetic client. */
  forceSyntheticClient?: boolean;
  internalDeliveryMediaUrls?: string[];
  internalDeliverySuppressText?: boolean;
  onAccepted?: (payload: unknown) => void;
  onSignalAbort?: () => Promise<void> | void;
  scopes?: string[];
  signal?: AbortSignal;
  syntheticScopes?: string[];
};

export type GatewayLifecycleAgentDispatchOptions = GatewayInstanceAgentDispatchOptions & {
  resolveGatewayContext?: GatewayContextResolver;
  timeoutMs?: number;
};

export type GatewayApprovalEventPublisher = {
  publishRequested: (kind: ChannelApprovalKind, request: unknown) => number;
  publishResolved: (kind: ChannelApprovalKind, resolved: unknown) => void;
};

export type GatewayRecoveryRuntime = {
  dispatchAgent: <T = unknown>(
    params: AgentRunRequest,
    timeoutMs?: number,
    options?: GatewayInstanceAgentDispatchOptions,
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
  isAvailable: () => boolean;
  close: () => void;
};
