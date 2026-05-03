import { getBootstrapChannelSecrets } from "../channels/plugins/bootstrap-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { loadChannelSecretContractApi } from "./channel-contract-api.js";
import { type ResolverContext, type SecretDefaults } from "./runtime-shared.js";

export function collectChannelConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): void {
  const channelIds = Object.keys(params.config.channels ?? {});
  if (channelIds.length === 0) {
    return;
  }
  for (const channelId of channelIds) {
    const contract = loadChannelSecretContractApi({
      channelId,
      config: params.config,
      env: params.context.env,
      loadablePluginOrigins: params.loadablePluginOrigins,
    });
    const collectRuntimeConfigAssignments =
      contract?.collectRuntimeConfigAssignments ??
      getBootstrapChannelSecrets(channelId)?.collectRuntimeConfigAssignments;
    collectRuntimeConfigAssignments?.(params);
  }
}
