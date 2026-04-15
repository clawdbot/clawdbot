import fs from "node:fs";
import path from "node:path";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isRecord } from "../utils.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";
import { applyPiCompactionSettingsFromConfig } from "./pi-settings.js";

const log = createSubsystemLogger("embedded-pi-settings");

export const DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY = "sanitize";
export const SANITIZED_PROJECT_PI_KEYS = ["shellPath", "shellCommandPrefix"] as const;

export type EmbeddedPiProjectSettingsPolicy = "trusted" | "sanitize" | "ignore";

type PiSettingsSnapshot = ReturnType<SettingsManager["getGlobalSettings"]> & {
  mcpServers?: Record<string, BundleMcpServerConfig>;
};

function sanitizePiSettingsSnapshot(settings: PiSettingsSnapshot): PiSettingsSnapshot {
  const sanitized = { ...settings };
  // Never allow plugin or workspace-local settings to override shell execution behavior.
  for (const key of SANITIZED_PROJECT_PI_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

function sanitizeProjectSettings(settings: PiSettingsSnapshot): PiSettingsSnapshot {
  return sanitizePiSettingsSnapshot(settings);
}

function loadBundleSettingsFile(params: {
  rootDir: string;
  relativePath: string;
}): PiSettingsSnapshot | null {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    log.warn(`skipping unsafe bundle settings file: ${absolutePath}`);
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    if (!isRecord(raw)) {
      log.warn(`skipping bundle settings file with non-object JSON: ${absolutePath}`);
      return null;
    }
    return sanitizePiSettingsSnapshot(raw as PiSettingsSnapshot);
  } catch (error) {
    log.warn(`failed to parse bundle settings file ${absolutePath}: ${String(error)}`);
    return null;
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function loadEnabledBundlePiSettingsSnapshot(params: {
  cwd: string;
  cfg?: OpenClawConfig;
}): PiSettingsSnapshot {
  const workspaceDir = params.cwd.trim();
  if (!workspaceDir) {
    return {};
  }
  const registry = loadPluginManifestRegistry({
    workspaceDir,
    config: params.cfg,
  });
  if (registry.plugins.length === 0) {
    return {};
  }

  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  let snapshot: PiSettingsSnapshot = {};

  for (const record of registry.plugins) {
    const settingsFiles = record.settingsFiles ?? [];
    if (record.format !== "bundle" || settingsFiles.length === 0) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.cfg,
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
      snapshot = applyMergePatch(snapshot, bundleSettings) as PiSettingsSnapshot;
    }
  }

  const embeddedPiMcp = loadEmbeddedPiMcpConfig({
    workspaceDir,
    cfg: params.cfg,
  });
  for (const diagnostic of embeddedPiMcp.diagnostics) {
    log.warn(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  if (Object.keys(embeddedPiMcp.mcpServers).length > 0) {
    snapshot = applyMergePatch(snapshot, {
      mcpServers: embeddedPiMcp.mcpServers,
    }) as PiSettingsSnapshot;
  }

  return snapshot;
}

export function resolveEmbeddedPiProjectSettingsPolicy(
  cfg?: OpenClawConfig,
): EmbeddedPiProjectSettingsPolicy {
  const raw = cfg?.agents?.defaults?.embeddedPi?.projectSettingsPolicy;
  if (raw === "trusted" || raw === "sanitize" || raw === "ignore") {
    return raw;
  }
  return DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY;
}

export function buildEmbeddedPiSettingsSnapshot(params: {
  globalSettings: PiSettingsSnapshot;
  pluginSettings?: PiSettingsSnapshot;
  projectSettings: PiSettingsSnapshot;
  policy: EmbeddedPiProjectSettingsPolicy;
}): PiSettingsSnapshot {
  const effectiveProjectSettings =
    params.policy === "ignore"
      ? {}
      : params.policy === "sanitize"
        ? sanitizeProjectSettings(params.projectSettings)
        : params.projectSettings;
  const withPluginSettings = applyMergePatch(
    params.globalSettings,
    sanitizePiSettingsSnapshot(params.pluginSettings ?? {}),
  ) as PiSettingsSnapshot;
  return applyMergePatch(withPluginSettings, effectiveProjectSettings) as PiSettingsSnapshot;
}

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
