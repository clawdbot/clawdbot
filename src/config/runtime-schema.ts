// Builds runtime config schema defaults from agent and workspace state.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  collectChannelSchemaMetadata,
  collectPluginSchemaMetadata,
} from "./channel-config-metadata.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "./schema.js";

// Runtime schemas include currently loaded plugin/channel metadata for accurate UI fields.
function loadManifestRegistry(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config), env);
  return resolvePluginMetadataSnapshot({
    config,
    env: env ?? process.env,
    workspaceDir,
    allowWorkspaceScopedCurrent: true,
  }).manifestRegistry;
}

/** Builds the config schema from the active runtime config and plugin metadata. */
export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = getRuntimeConfig();
  const registry = loadManifestRegistry(config);
  return buildConfigSchema({
    plugins: collectPluginSchemaMetadata(registry),
    channels: collectChannelSchemaMetadata(registry),
  });
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const snapshot = await readConfigFileSnapshot();
  const config = snapshot.valid
    ? snapshot.config
    : { agents: { list: [{ id: "main", default: true }] }, plugins: { enabled: true } };
  const registry = loadManifestRegistry(config);
  return buildConfigSchema({
    plugins: snapshot.valid ? collectPluginSchemaMetadata(registry) : [],
    channels: collectChannelSchemaMetadata(registry),
  });
}
