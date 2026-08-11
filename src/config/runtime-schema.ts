// Builds runtime config schema defaults from agent and workspace state.
import {
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "./channel-config-metadata.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import {
  getRuntimeAmbientEnvTriggers,
  getRuntimeConfigSourceSnapshot,
} from "./runtime-snapshot.js";
import { buildConfigSchemaCore, type ConfigSchemaResponse } from "./schema.js";

// The gateway's ambient env-trigger policy scopes ownership planning to the channels loader
// suppression actually plans for; outside a gateway process the slot is unset and the
// projection keeps the default policy.
function runtimeAmbientOwnershipOptions() {
  const ambientEnvTriggers = getRuntimeAmbientEnvTriggers();
  return ambientEnvTriggers ? { ambientEnvTriggers } : undefined;
}

// Runtime schemas include currently loaded plugin/channel metadata for accurate UI fields.
function loadManifestRegistry(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  return resolveConfigWidePluginManifestRegistry({
    config,
    env: env ?? process.env,
  });
}

/** Builds the config schema from the active runtime config and plugin metadata. */
export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = getRuntimeConfig();
  const registry = loadManifestRegistry(config);
  return buildConfigSchemaCore({
    plugins: collectPluginSchemaMetadataCore(registry),
    // Gateway startup publishes the auto-enabled config as the runtime snapshot, so ranking
    // ownership from it would read auto-enable's generated entries as operator selections. Rank
    // from the authored source published alongside it, the same config validation ranks from.
    channels: collectChannelSchemaMetadataCore(
      registry,
      getRuntimeConfigSourceSnapshot() ?? config,
      undefined,
      runtimeAmbientOwnershipOptions(),
    ),
  });
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
      config,
      undefined,
      runtimeAmbientOwnershipOptions(),
    ),
  });
}
