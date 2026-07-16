import type { GatewayNativeApprovalMethod } from "./approval-gateway-runtime-methods.js";
import type { ApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

export type GatewayApprovalEventKind = "exec" | "plugin";
export type GatewayApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
export type GatewayApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

export type GatewayApprovalEventSubscriber = {
  eventKinds: ReadonlySet<GatewayApprovalEventKind>;
  shouldHandle: (request: GatewayApprovalRequest) => boolean;
  onRequested: (request: GatewayApprovalRequest) => void;
  onResolved: (resolved: GatewayApprovalResolved) => void;
};

/** Gateway-owned authority and event transport for channel-native approval runtimes. */
export type GatewayNativeApprovalRuntime = {
  request: <T = unknown>(
    method: GatewayNativeApprovalMethod,
    params: Record<string, unknown>,
    options?: { clientDisplayName?: string },
  ) => Promise<T>;
  requestRoute: <T = unknown>(method: "send", params: Record<string, unknown>) => Promise<T>;
  routeCoordinator: ApprovalNativeRouteCoordinator;
  subscribe: (subscriber: GatewayApprovalEventSubscriber) => () => void;
};
