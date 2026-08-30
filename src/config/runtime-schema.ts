// Builds runtime config schema defaults from agent and workspace state.
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "./channel-config-metadata.js";
import { getRuntimeConfig, readConfigFileSnapshotWithPluginMetadata } from "./config.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import { buildConfigSchemaCore, type ConfigSchemaResponse } from "./schema.js";

// Registry identity follows the immutable metadata generation, so schema budgets
// and merging run once rather than serializing the same schemas on every read.
const schemasByRegistry = new WeakMap<PluginManifestRegistry, ConfigSchemaResponse>();

/** Builds one config schema from an exact manifest registry. */
export function buildRuntimeConfigSchemaFromRegistry(
  registry: PluginManifestRegistry,
): ConfigSchemaResponse {
  const cached = schemasByRegistry.get(registry);
  if (cached) {
    return cached;
  }
  const schema = buildConfigSchemaCore({
    plugins: collectPluginSchemaMetadataCore(registry),
    channels: collectChannelSchemaMetadataCore(registry),
    cache: false,
  });
  schemasByRegistry.set(registry, schema);
  return schema;
}

/** Builds the config schema from the active runtime config and plugin metadata. */
export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = getRuntimeConfig();
  const registry = resolveConfigWidePluginManifestRegistry({ config });
  return buildRuntimeConfigSchemaFromRegistry(registry);
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const { snapshot, pluginMetadata } = await readConfigFileSnapshotWithPluginMetadata({
    observe: false,
  });
  const config = snapshot.valid
    ? snapshot.config
    : { agents: { list: [{ id: "main" }] }, plugins: { enabled: true } };
  const registry = resolveConfigWidePluginManifestRegistry({
    config,
    metadata: snapshot.valid ? pluginMetadata : undefined,
    allowCurrent: false,
  });
  if (snapshot.valid) {
    return buildRuntimeConfigSchemaFromRegistry(registry);
  }
  return buildConfigSchemaCore({
    channels: collectChannelSchemaMetadataCore(registry),
    cache: false,
  });
}
