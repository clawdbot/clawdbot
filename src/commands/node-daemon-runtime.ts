/** Compatibility exports for the Node daemon runtime selector. */
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";

/** Runtime id accepted by Node daemon install/start helpers. */
export type NodeDaemonRuntime = GatewayDaemonRuntime;

/** Default Node daemon runtime, currently shared with the gateway daemon runtime. */
export const DEFAULT_NODE_DAEMON_RUNTIME = DEFAULT_GATEWAY_DAEMON_RUNTIME;

/** Returns true when a string is a supported Node daemon runtime id. */
export function isNodeDaemonRuntime(value: string | undefined): value is NodeDaemonRuntime {
  return isGatewayDaemonRuntime(value);
}
