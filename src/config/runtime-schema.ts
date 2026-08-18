// Builds runtime config schema defaults from agent and workspace state.
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  type ChannelOwnershipPolicy,
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "./channel-config-metadata.js";
import { createConfiguredChannelOwnershipPolicy } from "./channel-ownership-policy.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import { getRuntimeConfigSourceSnapshot } from "./runtime-snapshot.js";
import { buildConfigSchemaCore, type ConfigSchemaResponse } from "./schema.js";

// Runtime schemas include currently loaded plugin/channel metadata for accurate UI fields.
function loadManifestRegistry(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  return resolveConfigWidePluginManifestRegistry({
    config,
    env: env ?? process.env,
  });
}

// The operator-facing schema must describe the plugin the runtime actually activates, or config UI
// offers fields that `config validate` then rejects.
function ownershipPolicy(
  config: OpenClawConfig,
  registry: PluginManifestRegistry,
  sourceConfig: OpenClawConfig | null | undefined,
) {
  return createConfiguredChannelOwnershipPolicy({
    config,
    ...(sourceConfig ? { sourceConfig } : {}),
    registry,
    env: process.env,
  });
}

/**
 * Builds one config schema from an exact manifest registry.
 *
 * The policy is required, not optional: `uiHints` drive redaction, so a caller that skipped it
 * would silently describe a different owner than the runtime activates and could print a field the
 * configured owner marks sensitive. Every caller has a config to build one from.
 */
export function buildRuntimeConfigSchemaFromRegistry(
  registry: PluginManifestRegistry,
  policy: ChannelOwnershipPolicy,
): ConfigSchemaResponse {
  return buildConfigSchemaCore({
    plugins: collectPluginSchemaMetadataCore(registry),
    channels: collectChannelSchemaMetadataCore(registry, policy),
  });
}

/** Builds the config schema from the active runtime config and plugin metadata. */
export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = getRuntimeConfig();
  const registry = loadManifestRegistry(config);
  return buildRuntimeConfigSchemaFromRegistry(
    registry,
    ownershipPolicy(config, registry, getRuntimeConfigSourceSnapshot()),
  );
}

/**
 * Builds the schema for an exact config rather than the active runtime one.
 *
 * Write acknowledgements need this: ownership follows the operator's selection, so a write that
 * activates a replacement changes which plugin owns the channel. Redacting the committed config
 * with hints captured before the write can describe the previous owner and return a field the new
 * owner marks sensitive.
 */
export function buildRuntimeConfigSchemaForConfig(config: OpenClawConfig): ConfigSchemaResponse {
  const registry = loadManifestRegistry(config);
  return buildRuntimeConfigSchemaFromRegistry(
    registry,
    createConfiguredChannelOwnershipPolicy({ config, registry, env: process.env }),
  );
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const snapshot = await readConfigFileSnapshot({ observe: false });
  const config = snapshot.valid
    ? snapshot.config
    : { agents: { list: [{ id: "main" }] }, plugins: { enabled: true } };
  const registry = loadManifestRegistry(config);
  return buildConfigSchemaCore({
    plugins: snapshot.valid ? collectPluginSchemaMetadataCore(registry) : [],
    channels: collectChannelSchemaMetadataCore(
      registry,
      ownershipPolicy(config, registry, snapshot.valid ? snapshot.sourceConfig : undefined),
    ),
  });
}
