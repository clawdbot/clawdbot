import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";

let cached: { client: GatewayBrowserClient; result: SystemAgentSetupDetectResult } | undefined;

export function cacheModelSetupDetection(
  client: GatewayBrowserClient,
  result: SystemAgentSetupDetectResult,
): void {
  cached = { client, result };
}

export function consumeCachedModelSetupDetection(
  client: GatewayBrowserClient,
): SystemAgentSetupDetectResult | null {
  if (!cached) {
    return null;
  }
  if (cached.client !== client) {
    cached = undefined;
    return null;
  }
  const result = cached.result;
  cached = undefined;
  return result;
}
