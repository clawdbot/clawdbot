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

/** Creates the runtime SettingsManager with project/plugin settings and compaction overrides. */
export function createPreparedEmbeddedAgentSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Resolved context window budget so reserve-token floor can be capped for small models. */
  contextTokenBudget?: number;
}): SettingsManager {
  const fileSettingsManager = SettingsManager.create(params.cwd, params.agentDir);
  // Lock-backed reads stay authoritative; runtime writes and reloads use only this snapshot.
  const settingsManager = SettingsManager.inMemory(
    buildEmbeddedAgentSettingsSnapshot({
      globalSettings: fileSettingsManager.getGlobalSettings(),
      pluginSettings: loadEnabledBundleAgentSettingsSnapshot(params),
      projectSettings: fileSettingsManager.getProjectSettings(),
      policy: resolveEmbeddedAgentProjectSettingsPolicy(params.cfg),
    }),
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
