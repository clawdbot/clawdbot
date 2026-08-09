import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import type {
  GatewayApprovalEventKind,
  GatewayNativeApprovalRuntime,
} from "../infra/approval-gateway-runtime.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";

export type GatewayApprovalEventPublisher = {
  publishRequested: (kind: GatewayApprovalEventKind, request: unknown) => number;
  publishResolved: (kind: GatewayApprovalEventKind, resolved: unknown) => void;
};

export type GatewayRecoveryRuntime = {
  dispatchAgent: <T = unknown>(params: AgentRunRequest, timeoutMs?: number) => Promise<T>;
  waitForAgent: <T = unknown>(params: AgentWaitParams, timeoutMs?: number) => Promise<T>;
  sendRecoveryNotice: (params: {
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
    text: string;
    idempotencyKey: string;
  }) => Promise<void>;
};

export type GatewayInstanceRuntime = {
  approvalEvents: GatewayApprovalEventPublisher;
  nativeApprovals: GatewayNativeApprovalRuntime;
  recovery: GatewayRecoveryRuntime;
  close: () => void;
};
