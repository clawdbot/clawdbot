import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { collectBundledChannelConfigs } from "../plugins/bundled-channel-config-metadata.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import {
  collectChannelSchemaMetadata,
  collectPluginSchemaMetadata,
} from "./channel-config-metadata.js";
import { loadConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "./schema.js";

function loadManifestRegistry(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  return loadPluginManifestRegistryForPluginRegistry({
    config,
    cache: false,
    env,
    workspaceDir,
    includeDisabled: true,
    bundledChannelConfigCollector: collectBundledChannelConfigs,
  });
}

export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = loadConfig();
  const registry = loadManifestRegistry(config);
  return buildConfigSchema({
    plugins: collectPluginSchemaMetadata(registry),
    channels: collectChannelSchemaMetadata(registry),
  });
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const snapshot = await readConfigFileSnapshot();
  const config = snapshot.valid ? snapshot.config : { plugins: { enabled: true } };
  const registry = loadManifestRegistry(config);
  return buildConfigSchema({
    plugins: snapshot.valid ? collectPluginSchemaMetadata(registry) : [],
    channels: collectChannelSchemaMetadata(registry),
  });
}
