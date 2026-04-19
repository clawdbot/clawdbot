import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildEmbeddedPiSettingsSnapshot,
  loadEnabledBundlePiSettingsSnapshot,
  resolveEmbeddedPiProjectSettingsPolicy,
} from "./pi-project-settings-snapshot.js";
import { applyPiCompactionSettingsFromConfig } from "./pi-settings.js";

export {
  buildEmbeddedPiSettingsSnapshot,
  loadEnabledBundlePiSettingsSnapshot,
  resolveEmbeddedPiProjectSettingsPolicy,
} from "./pi-project-settings-snapshot.js";

export function createEmbeddedPiSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
}): SettingsManager {
  const fileSettingsManager = SettingsManager.create(params.cwd, params.agentDir);
  const policy = resolveEmbeddedPiProjectSettingsPolicy(params.cfg);
  const pluginSettings = loadEnabledBundlePiSettingsSnapshot({
    cwd: params.cwd,
    cfg: params.cfg,
  });
  const hasPluginSettings = Object.keys(pluginSettings).length > 0;
  if (policy === "trusted" && !hasPluginSettings) {
    return fileSettingsManager;
  }
  const settings = buildEmbeddedPiSettingsSnapshot({
    globalSettings: fileSettingsManager.getGlobalSettings(),
    pluginSettings,
    projectSettings: fileSettingsManager.getProjectSettings(),
    policy,
  });
  return SettingsManager.inMemory(settings);
}

export function createPreparedEmbeddedPiSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  /** Resolved context window budget so reserve-token floor can be capped for small models. */
  contextTokenBudget?: number;
}): SettingsManager {
  const settingsManager = createEmbeddedPiSettingsManager(params);
  applyPiCompactionSettingsFromConfig({
    settingsManager,
    cfg: params.cfg,
    contextTokenBudget: params.contextTokenBudget,
  });
  return settingsManager;
}
