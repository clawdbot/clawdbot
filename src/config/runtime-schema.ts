// Builds runtime config schema defaults from agent and workspace state.
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "./channel-config-metadata.js";
import { resolveChannelSchemaSelection } from "./channel-schema-selection.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import { buildConfigSchemaCore, type ConfigSchemaResponse } from "./schema.js";

// Runtime schemas include currently loaded plugin/channel metadata for accurate UI fields.
function loadManifestRegistry(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  return resolveConfigWidePluginManifestRegistry({
    config,
    env: env ?? process.env,
  });
}

/** Builds one config schema from an exact manifest registry. */
export function buildRuntimeConfigSchemaFromRegistry(
  registry: PluginManifestRegistry,
  config: OpenClawConfig,
): ConfigSchemaResponse {
  return buildConfigSchemaCore({
    plugins: collectPluginSchemaMetadataCore(registry),
    channels: collectChannelSchemaMetadataCore(
      registry,
      resolveChannelSchemaSelection(registry, config),
    ),
  });
}

/** Builds the config schema from the active runtime config and plugin metadata. */
export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = getRuntimeConfig();
  const registry = loadManifestRegistry(config);
  return buildRuntimeConfigSchemaFromRegistry(registry, config);
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const snapshot = await readConfigFileSnapshot({ observe: false });
  const config = snapshot.valid
    ? snapshot.sourceConfig
    : { agents: { list: [{ id: "main" }] }, plugins: { enabled: true } };
  const registry = loadManifestRegistry(config);
  return buildConfigSchemaCore({
    plugins: snapshot.valid ? collectPluginSchemaMetadataCore(registry) : [],
    channels: collectChannelSchemaMetadataCore(
      registry,
      resolveChannelSchemaSelection(registry, config),
    ),
  });
}
