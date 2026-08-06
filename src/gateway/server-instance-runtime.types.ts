import type {
  GatewayApprovalEventKind,
  GatewayNativeApprovalRuntime,
} from "../infra/approval-gateway-runtime.types.js";

export type GatewayApprovalEventPublisher = {
  publishRequested: (kind: GatewayApprovalEventKind, request: unknown) => number;
  publishResolved: (kind: GatewayApprovalEventKind, resolved: unknown) => void;
};

export type GatewayRecoveryRuntime = {
  dispatchAgent: <T = unknown>(params: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  waitForAgent: <T = unknown>(params: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  sendRecoveryNotice: <T = unknown>(
    params: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<T>;
};

export type GatewayInstanceRuntime = {
  approvalEvents: GatewayApprovalEventPublisher;
  nativeApprovals: GatewayNativeApprovalRuntime;
  recovery: GatewayRecoveryRuntime;
  close: () => void;
};
