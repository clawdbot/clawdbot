import type { GatewayNativeApprovalMethod } from "./approval-gateway-runtime-methods.js";
import type { ApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import type { ApprovalRequest, ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalResolved } from "./plugin-approvals.js";
import type { SystemAgentApprovalResolved } from "./system-agent-approvals.js";

export type GatewayApprovalRequest = ApprovalRequest;
export type GatewayApprovalResolved =
  | ExecApprovalResolved
  | PluginApprovalResolved
  | SystemAgentApprovalResolved;

export type GatewayApprovalEventSubscriber = {
  eventKinds: ReadonlySet<ChannelApprovalKind>;
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
