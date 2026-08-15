/** Collects config-backed secret targets for runtime secret preparation. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { collectChannelConfigAssignments } from "./runtime-config-collectors-channels.js";
import { collectCoreConfigAssignments } from "./runtime-config-collectors-core.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import type { ResolverContext } from "./runtime-shared.js";

/** Collects every config-backed SecretRef assignment before runtime values are materialized. */
/** Collects concrete config path assignments that may need SecretRef conversion. */
export function collectConfigAssignments(params: {
  /** Mutable config snapshot that resolved secret values will be written back into. */
  config: OpenClawConfig;
  /** Resolver context carrying source config, env, cache, assignments, and warnings. */
  context: ResolverContext;
  /** Optional installed plugin roots for channel/plugin contract lookup. */
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
    loadablePluginOrigins: params.loadablePluginOrigins,
  });

  collectPluginConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
    loadablePluginOrigins: params.loadablePluginOrigins,
  });
}
