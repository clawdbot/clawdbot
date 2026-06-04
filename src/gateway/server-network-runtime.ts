import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";

// Gateway network bootstrap installs the global undici proxy dispatcher before
// server code makes outbound fetch calls.
/** Applies process-wide gateway network runtime setup. */
export function bootstrapGatewayNetworkRuntime(): void {
  ensureGlobalUndiciEnvProxyDispatcher();
}
