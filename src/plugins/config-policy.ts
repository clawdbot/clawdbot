// Evaluates plugin config policy without activating plugin runtime code.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginActivationDecisionShared,
  toPluginActivationState,
  type PluginActivationStateLike,
} from "./config-activation-shared.js";
import {
  identityNormalizePluginId,
  normalizePluginsConfigWithResolverCore as normalizePluginsConfigWithResolverShared,
  resolveChannelConfigEnablement,
  type NormalizePluginId,
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type PluginActivationState = PluginActivationStateLike;

type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

export function normalizePluginsConfigWithResolver(
  config?: OpenClawConfig["plugins"],
  normalizePluginId: NormalizePluginId = identityNormalizePluginId,
): NormalizedPluginsConfig {
  return normalizePluginsConfigWithResolverShared(config, normalizePluginId);
}

type PolicyEffectiveActivationParams = {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  sourceConfig?: NormalizedPluginsConfig;
  sourceRootConfig?: OpenClawConfig;
  autoEnabledReason?: string;
  channelIds?: readonly string[];
};

export function resolvePolicyPluginActivationState(
  params: PolicyEffectiveActivationParams,
): PluginActivationState {
  return toPluginActivationState(
    resolvePluginActivationDecisionShared({
      ...params,
      activationSource: {
        plugins: params.sourceConfig ?? params.config,
        rootConfig: params.sourceRootConfig ?? params.rootConfig,
      },
      resolveChannelConfigEnablement,
    }),
  );
}
