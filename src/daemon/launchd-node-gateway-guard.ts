/** Shared node-vs-gateway LaunchAgent port ownership policy.
 *
 * `openclaw node stop`/`node restart` reuse the generic gateway LaunchAgent
 * lifecycle code paths, but a node-host service never binds the gateway's
 * own port — it only ever connects outward to a gateway as a client. When a
 * node LaunchAgent is co-located on the same host as a running Gateway
 * LaunchAgent, the generic "is the gateway port busy, and if so is it
 * verifiably owned by *this* LaunchAgent" checks would otherwise see the
 * co-located Gateway's own (legitimately still-open) port and report a
 * false-positive "still busy" failure for both stop and restart.
 *
 * Both `stopLaunchAgent` (src/daemon/launchd-stop.ts) and
 * `restartLaunchAgent` (src/daemon/launchd-lifecycle.ts) must apply the same
 * exemption so the two lifecycle operations don't diverge. See
 * openclaw/openclaw#124296.
 */
import { NODE_SERVICE_KIND } from "./constants.js";
import type { GatewayServiceEnv } from "./service-types.js";

/**
 * Returns true when the gateway-port-ownership assertion used by the
 * LaunchAgent stop/restart paths should be skipped entirely for this
 * service, because the service is a node-host service and can never
 * legitimately own the gateway's listening port.
 */
export function shouldSkipGatewayPortOwnershipCheck(env: GatewayServiceEnv): boolean {
  return env.OPENCLAW_SERVICE_KIND?.trim() === NODE_SERVICE_KIND;
}
