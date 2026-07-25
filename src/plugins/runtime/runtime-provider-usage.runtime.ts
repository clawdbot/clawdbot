// Lazy bridge: keeps the plugin runtime entrypoint small while provider usage stays core-owned.
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import { readProviderUsageProfile } from "../../infra/provider-usage.profile.js";
import type {
  ProviderUsageProfileReadParams,
  ProviderUsageProfileSnapshot,
} from "../../infra/provider-usage.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";

/** Runtime bridge for exact-profile provider usage reads. */
export async function readProviderUsageProfileForRuntime(
  params: ProviderUsageProfileReadParams,
): Promise<ProviderUsageProfileSnapshot> {
  const scopedAgentId = getPluginRuntimeGatewayRequestScope()?.agentId?.trim();
  if (!scopedAgentId) {
    throw new Error("Provider usage reads require a trusted active agent scope.");
  }
  const config = getRuntimeConfig();
  const agentDir = resolveAgentDir(config, normalizeAgentId(scopedAgentId));
  return readProviderUsageProfile(params, { config, agentDir });
}
