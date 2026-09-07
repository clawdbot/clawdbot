// Evaluates plugin config policy without activating plugin runtime code.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginActivationDecisionShared,
  toPluginActivationState,
  type PluginActivationStateLike as PluginActivationState,
} from "./config-activation-shared.js";
import {
  resolveChannelConfigEnablement,
  type NormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export { normalizePluginsConfigWithResolverCore as normalizePluginsConfigWithResolver } from "./config-normalization-shared.js";

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
