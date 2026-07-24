/** Prepares embedded-agent SettingsManager instances from project and plugin settings. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  buildEmbeddedAgentSettingsSnapshot,
  loadEnabledBundleAgentSettingsSnapshot,
  resolveEmbeddedAgentProjectSettingsPolicy,
} from "./agent-project-settings-snapshot.js";
import { applyAgentCompactionSettingsFromConfig } from "./agent-settings.js";
import { SettingsManager } from "./sessions/index.js";

function createEmbeddedAgentSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}): SettingsManager {
  const fileSettingsManager = SettingsManager.create(params.cwd, params.agentDir);
  const policy = resolveEmbeddedAgentProjectSettingsPolicy(params.cfg);
  const pluginSettings = loadEnabledBundleAgentSettingsSnapshot({
    cwd: params.cwd,
    cfg: params.cfg,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
  });
  const hasPluginSettings = Object.keys(pluginSettings).length > 0;
  if (policy === "trusted" && !hasPluginSettings) {
    return fileSettingsManager;
  }
  const settings = buildEmbeddedAgentSettingsSnapshot({
    globalSettings: fileSettingsManager.getGlobalSettings(),
    pluginSettings,
    projectSettings: fileSettingsManager.getProjectSettings(),
    policy,
  });
  return SettingsManager.inMemory(settings);
}

function createRuntimeEmbeddedAgentSettingsManager(
  settingsManager: SettingsManager,
): SettingsManager {
  return SettingsManager.inMemory(
    buildEmbeddedAgentSettingsSnapshot({
      globalSettings: settingsManager.getGlobalSettings(),
      pluginSettings: {},
      projectSettings: settingsManager.getProjectSettings(),
      policy: "trusted",
    }),
  );
}

/**
 * Resolves the configured provider retry budget (settings.retry.provider.maxRetries)
 * from the same project/plugin settings the embedded runner reads. The reply
 * orchestrator wires this once onto the prepared run so the outer whole-attempt
 * retry owner can restore the budget the in-window SDK pin drops (#87180); unset
 * leaves the shipped single outer retry.
 */
export function resolveConfiguredProviderRetryMaxRetries(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}): number | undefined {
  return createEmbeddedAgentSettingsManager(params).getProviderRetrySettings().maxRetries;
}

/** Creates the runtime SettingsManager with project/plugin settings and compaction overrides. */
export function createPreparedEmbeddedAgentSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Resolved context window budget so reserve-token floor can be capped for small models. */
  contextTokenBudget?: number;
}): SettingsManager {
  const settingsManager = createRuntimeEmbeddedAgentSettingsManager(
    createEmbeddedAgentSettingsManager(params),
  );
  applyAgentCompactionSettingsFromConfig({
    settingsManager,
    cfg: params.cfg,
    contextTokenBudget: params.contextTokenBudget,
  });
  // Disable the session runtime auto-retry. OpenClaw has its own comprehensive
  // retry layer (failover rotation, auth profile rotation, empty-error retry,
  // thinking-level fallback) in run.ts. Having both layers active creates a
  // double-retry that can replay failed tool calls in an unbounded loop (#73781).
  settingsManager.setRetryEnabled(false);
  return settingsManager;
}
