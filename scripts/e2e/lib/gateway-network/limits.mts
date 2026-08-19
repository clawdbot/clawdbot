// Limits shared by gateway network E2E fixtures.
import { readPositiveIntEnv } from "../env-limits.mjs";

export function readGatewayNetworkClientConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS != null) {
    return readPositiveIntEnv("OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS", 80000, env);
  }
  return readPositiveIntEnv("OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS", 80000, env);
}
