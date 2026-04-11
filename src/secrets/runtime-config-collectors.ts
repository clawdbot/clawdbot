import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/types.js";
import { collectChannelConfigAssignments } from "./runtime-config-collectors-channels.js";
import { collectCoreConfigAssignments } from "./runtime-config-collectors-core.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import type { ResolverContext } from "./runtime-shared.js";

export function collectConfigAssignments(params: {
  config: OpenClawConfig;
  context: ResolverContext;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): void {
  const defaults = params.context.sourceConfig.secrets?.defaults;

  collectCoreConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
  });

  collectChannelConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
  });

  collectPluginConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
    loadablePluginOrigins: params.loadablePluginOrigins,
  });
}
