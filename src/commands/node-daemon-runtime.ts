import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  isGatewayDaemonRuntime,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";

export type NodeDaemonRuntime = GatewayDaemonRuntime;

export const DEFAULT_NODE_DAEMON_RUNTIME = DEFAULT_GATEWAY_DAEMON_RUNTIME;

export const NODE_DAEMON_RUNTIME_OPTIONS = GATEWAY_DAEMON_RUNTIME_OPTIONS;

export function isNodeDaemonRuntime(value: string | undefined): value is NodeDaemonRuntime {
  return isGatewayDaemonRuntime(value);
}
