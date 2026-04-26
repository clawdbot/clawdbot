import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";

export function bootstrapGatewayNetworkRuntime(): void {
  ensureGlobalUndiciEnvProxyDispatcher();
}
