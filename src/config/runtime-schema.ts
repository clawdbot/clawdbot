// Builds runtime config schema defaults from agent and workspace state.
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "./channel-config-metadata.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import { isPluginPolicyDisabled } from "./plugin-replacement-eligibility.js";
import { buildConfigSchemaCore, type ConfigSchemaResponse } from "./schema.js";

// Runtime schemas include currently loaded plugin/channel metadata for accurate UI fields.
function loadManifestRegistry(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  return resolveConfigWidePluginManifestRegistry({
    config,
    env: env ?? process.env,
  });
}

/**
 * The operator-facing schema must describe the plugin the runtime actually activates. A channel
 * whose declared replacement is denied or disabled falls back to the replaced plugin, so config UI
 * would otherwise offer fields that `config validate` then rejects.
 */
function canReplaceChannelOwner(config: OpenClawConfig): (pluginId: string) => boolean {
  return (pluginId) => !isPluginPolicyDisabled(config, pluginId);
}

/**
 * Builds one config schema from an exact manifest registry. Callers holding the active config pass
 * the replacement predicate so the schema names the owner the runtime activates; callers that only
 * have a registry (CLI redaction hints) omit it and get the unfiltered owner.
 */
export function buildRuntimeConfigSchemaFromRegistry(
  registry: PluginManifestRegistry,
  canReplaceOwner?: (pluginId: string) => boolean,
): ConfigSchemaResponse {
  return buildConfigSchemaCore({
    plugins: collectPluginSchemaMetadataCore(registry),
    channels: collectChannelSchemaMetadataCore(registry, canReplaceOwner),
  });
}

/** Builds the config schema from the active runtime config and plugin metadata. */
export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = getRuntimeConfig();
  const registry = loadManifestRegistry(config);
  return buildRuntimeConfigSchemaFromRegistry(registry, canReplaceChannelOwner(config));
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const snapshot = await readConfigFileSnapshot({ observe: false });
  const config = snapshot.valid
    ? snapshot.config
    : { agents: { list: [{ id: "main" }] }, plugins: { enabled: true } };
  const registry = loadManifestRegistry(config);
  return buildConfigSchemaCore({
    plugins: snapshot.valid ? collectPluginSchemaMetadataCore(registry) : [],
    channels: collectChannelSchemaMetadataCore(registry, canReplaceChannelOwner(config)),
  });
}
