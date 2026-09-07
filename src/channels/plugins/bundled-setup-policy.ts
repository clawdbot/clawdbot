import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NormalizedPluginsConfig } from "../../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../../plugins/manifest-owner-policy.js";

export function shouldIncludeChannelSetupFeatureForConfig(params: {
  plugin: { id: string; channels?: readonly string[] };
  config?: OpenClawConfig;
  normalizedConfig: NormalizedPluginsConfig;
}): boolean {
  if (!params.config) {
    return true;
  }
  const pluginId = params.plugin.id;
  if (
    !passesManifestOwnerBasePolicy({
      plugin: { id: pluginId },
      normalizedConfig: params.normalizedConfig,
      allowRestrictiveAllowlistBypass: true,
    })
  ) {
    return false;
  }

  let hasExplicitChannelDisable = false;
  for (const channelId of params.plugin.channels ?? [pluginId]) {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!normalizedChannelId) {
      continue;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
      continue;
    }
    if ((channelConfig as { enabled?: unknown }).enabled === false) {
      hasExplicitChannelDisable = true;
      continue;
    }
    return true;
  }

  return !hasExplicitChannelDisable;
}
