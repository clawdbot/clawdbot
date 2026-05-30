import path from "node:path";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import {
  normalizePluginsConfigWithResolver,
  resolveEffectivePluginActivationState,
} from "../plugins/config-policy.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  isPluginMetadataSnapshotCompatible,
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { loadEmbeddedAgentMcpConfig } from "./embedded-agent-mcp.js";
import type { SettingsManager } from "./sessions/index.js";

const log = createSubsystemLogger("embedded-agent-settings");

export const DEFAULT_EMBEDDED_AGENT_PROJECT_SETTINGS_POLICY = "sanitize";
const SANITIZED_PROJECT_AGENT_KEYS = ["shellPath", "shellCommandPrefix"] as const;

export type EmbeddedAgentProjectSettingsPolicy = "trusted" | "sanitize" | "ignore";

export type AgentSettingsSnapshot = ReturnType<SettingsManager["getGlobalSettings"]> & {
  mcpServers?: Record<string, BundleMcpServerConfig>;
};

function sanitizeAgentSettingsSnapshot(settings: AgentSettingsSnapshot): AgentSettingsSnapshot {
  const sanitized = { ...settings };
  // Never allow plugin or workspace-local settings to override shell execution behavior.
  for (const key of SANITIZED_PROJECT_AGENT_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

function sanitizeProjectSettings(settings: AgentSettingsSnapshot): AgentSettingsSnapshot {
  return sanitizeAgentSettingsSnapshot(settings);
}

function canReuseUnscopedCurrentPluginMetadataSnapshot(config: OpenClawConfig): boolean {
  return normalizePluginsConfigWithResolver(config.plugins).loadPaths.length === 0;
}

function resolveUnscopedCurrentPluginMetadataSnapshot(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): PluginMetadataSnapshot | undefined {
  if (!canReuseUnscopedCurrentPluginMetadataSnapshot(params.config)) {
    return undefined;
  }
  return getCurrentPluginMetadataSnapshot({
    env: params.env,
    workspaceDir: params.workspaceDir,
    allowWorkspaceScopedSnapshot: true,
    requireDefaultDiscoveryContext: true,
  });
}

function loadBundleSettingsFile(params: {
  rootDir: string;
  relativePath: string;
}): AgentSettingsSnapshot | null {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const result = readRootJsonObjectSync({
    rootDir: params.rootDir,
    relativePath: params.relativePath,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!result.ok && result.reason === "open") {
    log.warn(`skipping unsafe bundle settings file: ${absolutePath}`);
    return null;
  }
  if (!result.ok) {
    log.warn(`${result.error}: ${absolutePath}`);
    return null;
  }
  return sanitizeAgentSettingsSnapshot(result.value as AgentSettingsSnapshot);
}

export function loadEnabledBundleAgentSettingsSnapshot(params: {
  cwd: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}): AgentSettingsSnapshot {
  const workspaceDir = params.cwd.trim();
  if (!workspaceDir) {
    return {};
  }
  const config = params.cfg ?? {};
  const env = params.env ?? process.env;
  const providedSnapshot = params.pluginMetadataSnapshot;
  const metadataSnapshot =
    providedSnapshot &&
    isPluginMetadataSnapshotCompatible({
      snapshot: providedSnapshot,
      config,
      env,
      workspaceDir,
    })
      ? providedSnapshot
      : (getCurrentPluginMetadataSnapshot({
          config,
          env,
          workspaceDir,
        }) ??
        resolveUnscopedCurrentPluginMetadataSnapshot({
          config,
          env,
          workspaceDir,
        }) ??
        loadPluginMetadataSnapshot({
          workspaceDir,
          config,
          env,
        }));
  const registry = metadataSnapshot.manifestRegistry;
  if (registry.plugins.length === 0) {
    return {};
  }

  const normalizedPlugins = normalizePluginsConfigWithResolver(
    config.plugins,
    metadataSnapshot.normalizePluginId,
  );
  let snapshot: AgentSettingsSnapshot = {};

  for (const record of registry.plugins) {
    const settingsFiles = record.settingsFiles ?? [];
    if (record.format !== "bundle" || settingsFiles.length === 0) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: config,
    });
    if (!activationState.activated) {
      continue;
    }
    for (const relativePath of settingsFiles) {
      const bundleSettings = loadBundleSettingsFile({
        rootDir: record.rootDir,
        relativePath,
      });
      if (!bundleSettings) {
        continue;
      }
      snapshot = applyMergePatch(snapshot, bundleSettings) as AgentSettingsSnapshot;
    }
  }

  const embeddedAgentMcp = loadEmbeddedAgentMcpConfig({
    workspaceDir,
    cfg: config,
    manifestRegistry: metadataSnapshot.manifestRegistry,
  });
  for (const diagnostic of embeddedAgentMcp.diagnostics) {
    log.warn(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  if (Object.keys(embeddedAgentMcp.mcpServers).length > 0) {
    snapshot = applyMergePatch(snapshot, {
      mcpServers: embeddedAgentMcp.mcpServers,
    }) as AgentSettingsSnapshot;
  }

  return snapshot;
}

export function resolveEmbeddedAgentProjectSettingsPolicy(
  cfg?: OpenClawConfig,
): EmbeddedAgentProjectSettingsPolicy {
  const raw = cfg?.agents?.defaults?.embeddedAgent?.projectSettingsPolicy;
  if (raw === "trusted" || raw === "sanitize" || raw === "ignore") {
    return raw;
  }
  return DEFAULT_EMBEDDED_AGENT_PROJECT_SETTINGS_POLICY;
}

export function buildEmbeddedAgentSettingsSnapshot(params: {
  globalSettings: AgentSettingsSnapshot;
  pluginSettings?: AgentSettingsSnapshot;
  projectSettings: AgentSettingsSnapshot;
  policy: EmbeddedAgentProjectSettingsPolicy;
}): AgentSettingsSnapshot {
  const effectiveProjectSettings =
    params.policy === "ignore"
      ? {}
      : params.policy === "sanitize"
        ? sanitizeProjectSettings(params.projectSettings)
        : params.projectSettings;
  const withPluginSettings = applyMergePatch(
    params.globalSettings,
    sanitizeAgentSettingsSnapshot(params.pluginSettings ?? {}),
  ) as AgentSettingsSnapshot;
  return applyMergePatch(withPluginSettings, effectiveProjectSettings) as AgentSettingsSnapshot;
}
