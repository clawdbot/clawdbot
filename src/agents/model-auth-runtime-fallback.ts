import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ModelAuthAvailability } from "./model-auth-availability.js";
import { resolveCliRuntimeExecutionProvider } from "./model-runtime-aliases.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";

/** Projects physical CLI-runtime auth onto one logical model row without merging provider identities. */
export function resolveModelRuntimeAuthAvailability(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  modelId: string;
  metadataSnapshot: PluginMetadataSnapshot;
  primaryAvailability: ModelAuthAvailability;
  resolveProviderAvailability: (provider: string) => ModelAuthAvailability;
}): ModelAuthAvailability {
  const runtimePolicy = resolveModelRuntimePolicy({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  });
  if (!runtimePolicy.policy) {
    return params.primaryAvailability;
  }
  const runtimeProvider = resolveCliRuntimeExecutionProvider({
    provider: params.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    modelId: params.modelId,
    metadataSnapshot: params.metadataSnapshot,
  });
  if (
    !runtimeProvider ||
    normalizeProviderId(runtimeProvider) === normalizeProviderId(params.provider)
  ) {
    return params.primaryAvailability;
  }
  return params.resolveProviderAvailability(runtimeProvider);
}
