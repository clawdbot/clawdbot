import { resolvePluginActivationSourceConfig } from "../plugins/activation-source-config.js";
import { canStartConfiguredChannelPlugin } from "../plugins/channel-startup-policy.js";
import { createPluginActivationSource, normalizePluginsConfig } from "../plugins/config-state.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveConfiguredChannelAutoEnableCandidates } from "./plugin-auto-enable.channels.js";
import { materializePluginAutoEnableCandidatesInternal } from "./plugin-auto-enable.materialize.js";
import { getRuntimeConfigSnapshot } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Select metadata owners through the same preference and eligibility policy as channel startup. */
export function resolveChannelSchemaSelection(
  registry: PluginManifestRegistry,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const activationSourceConfig = resolvePluginActivationSourceConfig({ config });
  // Runtime config already carries startup's selection. Reapplying auto-enable would
  // mistake generated enabled entries for the operator's explicit choices.
  // Metadata-only reads prepare channel candidates without executing setup probes.
  const effectiveConfig =
    config === getRuntimeConfigSnapshot()
      ? config
      : materializePluginAutoEnableCandidatesInternal({
          config: activationSourceConfig,
          candidates: resolveConfiguredChannelAutoEnableCandidates({
            config: activationSourceConfig,
            env,
            registry,
          }),
          env,
          manifestRegistry: registry,
        }).config;
  const pluginsConfig = normalizePluginsConfig(effectiveConfig.plugins);
  const activationSource = createPluginActivationSource({ config: activationSourceConfig });
  return new Set(
    registry.plugins
      .filter(
        (plugin) =>
          plugin.channels.length > 0 &&
          canStartConfiguredChannelPlugin({
            id: plugin.id,
            origin: plugin.origin,
            channelIds: plugin.channels,
            config: effectiveConfig,
            pluginsConfig,
            activationSource,
          }),
      )
      .map((plugin) => plugin.id),
  );
}
