import { resolvePluginActivationSourceConfig } from "../plugins/activation-source-config.js";
import { resolveDiscoverableScopedChannelPluginIds } from "../plugins/channel-presence-policy.js";
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
  return new Set(
    resolveDiscoverableScopedChannelPluginIds({
      config: effectiveConfig,
      activationSourceConfig,
      channelIds: registry.plugins.flatMap((plugin) => plugin.channels),
      manifestRecords: registry.plugins,
      env,
    }),
  );
}
