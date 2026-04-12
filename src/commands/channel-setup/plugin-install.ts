import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { resolveBundledInstallPlanForCatalogEntry } from "../../cli/plugin-install-plan.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  findBundledPluginSourceInMap,
  resolveBundledPluginSources,
} from "../../plugins/bundled-sources.js";
import { clearPluginDiscoveryCache } from "../../plugins/discovery.js";
import { enablePluginInConfig } from "../../plugins/enable.js";
import { installPluginFromNpmSpec } from "../../plugins/install.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "../../plugins/installs.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createPluginLoaderLogger } from "../../plugins/logger.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { getTrustedChannelPluginCatalogEntry } from "./trusted-catalog.js";

type InstallChoice = "npm" | "local" | "skip";

type InstallResult = {
  cfg: OpenClawConfig;
  installed: boolean;
  pluginId?: string;
};

function hasGitWorkspace(workspaceDir?: string): boolean {
  const candidates = new Set<string>();
  candidates.add(path.join(process.cwd(), ".git"));
  if (workspaceDir && workspaceDir !== process.cwd()) {
    candidates.add(path.join(workspaceDir, ".git"));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return true;
    }
  }
  return false;
}

function resolveLocalPath(
  entry: ChannelPluginCatalogEntry,
  workspaceDir: string | undefined,
  allowLocal: boolean,
): string | null {
  if (!allowLocal) {
    return null;
  }
  const raw = entry.install.localPath?.trim();
  if (!raw) {
    return null;
  }
  const candidates = new Set<string>();
  candidates.add(path.resolve(process.cwd(), raw));
  if (workspaceDir && workspaceDir !== process.cwd()) {
    candidates.add(path.resolve(workspaceDir, raw));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function addPluginLoadPath(cfg: OpenClawConfig, pluginPath: string): OpenClawConfig {
  const existing = cfg.plugins?.load?.paths ?? [];
  const merged = Array.from(new Set([...existing, pluginPath]));
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      load: {
        ...cfg.plugins?.load,
        paths: merged,
      },
    },
  };
}

async function promptInstallChoice(params: {
  entry: ChannelPluginCatalogEntry;
  localPath?: string | null;
  defaultChoice: InstallChoice;
  prompter: WizardPrompter;
}): Promise<InstallChoice> {
  const { entry, localPath, prompter, defaultChoice } = params;
  const localOptions: Array<{ value: InstallChoice; label: string; hint?: string }> = localPath
    ? [
        {
          value: "local",
          label: "Use local plugin path",
          hint: localPath,
        },
      ]
    : [];
  const options: Array<{ value: InstallChoice; label: string; hint?: string }> = [
    { value: "npm", label: `Download from npm (${entry.install.npmSpec})` },
    ...localOptions,
    { value: "skip", label: "Skip for now" },
  ];
  const initialValue: InstallChoice =
    defaultChoice === "local" && !localPath ? "npm" : defaultChoice;
  return await prompter.select<InstallChoice>({
    message: `Install ${entry.meta.label} plugin?`,
    options,
    initialValue,
  });
}

function resolveInstallDefaultChoice(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  localPath?: string | null;
  bundledLocalPath?: string | null;
}): InstallChoice {
  const { cfg, entry, localPath, bundledLocalPath } = params;
  if (bundledLocalPath) {
    return "local";
  }
  const updateChannel = cfg.update?.channel;
  if (updateChannel === "dev") {
    return localPath ? "local" : "npm";
  }
  if (updateChannel === "stable" || updateChannel === "beta") {
    return "npm";
  }
  const entryDefault = entry.install.defaultChoice;
  if (entryDefault === "local") {
    return localPath ? "local" : "npm";
  }
  if (entryDefault === "npm") {
    return "npm";
  }
  return localPath ? "local" : "npm";
}

export async function ensureChannelSetupPluginInstalled(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): Promise<InstallResult> {
  const { entry, prompter, runtime, workspaceDir } = params;
  let next = params.cfg;
  const allowLocal = hasGitWorkspace(workspaceDir);
  const bundledSources = resolveBundledPluginSources({ workspaceDir });
  const bundledLocalPath =
    resolveBundledInstallPlanForCatalogEntry({
      pluginId: entry.id,
      npmSpec: entry.install.npmSpec,
      findBundledSource: (lookup) =>
        findBundledPluginSourceInMap({ bundled: bundledSources, lookup }),
    })?.bundledSource.localPath ?? null;
  const localPath = bundledLocalPath ?? resolveLocalPath(entry, workspaceDir, allowLocal);
  const defaultChoice = resolveInstallDefaultChoice({
    cfg: next,
    entry,
    localPath,
    bundledLocalPath,
  });
  const choice = await promptInstallChoice({
    entry,
    localPath,
    defaultChoice,
    prompter,
  });

  if (choice === "skip") {
    return { cfg: next, installed: false };
  }

  if (choice === "local" && localPath) {
    next = addPluginLoadPath(next, localPath);
    const pluginId = entry.pluginId ?? entry.id;
    next = enablePluginInConfig(next, pluginId).config;
    return { cfg: next, installed: true, pluginId };
  }

  const result = await installPluginFromNpmSpec({
    spec: entry.install.npmSpec,
    logger: {
      info: (msg) => runtime.log?.(msg),
      warn: (msg) => runtime.log?.(msg),
    },
  });

  if (result.ok) {
    next = enablePluginInConfig(next, result.pluginId).config;
    next = recordPluginInstall(next, {
      pluginId: result.pluginId,
      source: "npm",
      spec: entry.install.npmSpec,
      installPath: result.targetDir,
      version: result.version,
      ...buildNpmResolutionInstallFields(result.npmResolution),
    });
    return { cfg: next, installed: true, pluginId: result.pluginId };
  }

  await prompter.note(
    `Failed to install ${entry.install.npmSpec}: ${result.error}`,
    "Plugin install",
  );

  if (localPath) {
    const fallback = await prompter.confirm({
      message: `Use local plugin path instead? (${localPath})`,
      initialValue: true,
    });
    if (fallback) {
      next = addPluginLoadPath(next, localPath);
      const pluginId = entry.pluginId ?? entry.id;
      next = enablePluginInConfig(next, pluginId).config;
      return { cfg: next, installed: true, pluginId };
    }
  }

  runtime.error?.(`Plugin install failed: ${result.error}`);
  return { cfg: next, installed: false };
}

export function reloadChannelSetupPluginRegistry(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): void {
  loadChannelSetupPluginRegistry(params);
}

function loadChannelSetupPluginRegistry(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  activate?: boolean;
}): PluginRegistry {
  clearPluginDiscoveryCache();
  const autoEnabled = applyPluginAutoEnable({ config: params.cfg, env: process.env });
  const resolvedConfig = autoEnabled.config;
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(resolvedConfig, resolveDefaultAgentId(resolvedConfig));
  const log = createSubsystemLogger("plugins");
  return loadOpenClawPlugins({
    config: resolvedConfig,
    activationSourceConfig: params.cfg,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    cache: false,
    logger: createPluginLoaderLogger(log),
    onlyPluginIds: params.onlyPluginIds,
    includeSetupOnlyChannelPlugins: true,
    activate: params.activate,
  });
}

function resolveScopedChannelPluginId(params: {
  cfg: OpenClawConfig;
  channel: string;
  pluginId?: string;
  workspaceDir?: string;
}): string | undefined {
  const explicitPluginId = params.pluginId?.trim();
  if (explicitPluginId) {
    return explicitPluginId;
  }
  return (
    getTrustedChannelPluginCatalogEntry(params.channel, {
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
    })?.pluginId ?? resolveUniqueManifestScopedChannelPluginId(params)
  );
}

function resolveUniqueManifestScopedChannelPluginId(params: {
  cfg: OpenClawConfig;
  channel: string;
  workspaceDir?: string;
}): string | undefined {
  const matches = loadPluginManifestRegistry({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    cache: false,
    env: process.env,
  }).plugins.filter((plugin) => plugin.channels.includes(params.channel));
  return matches.length === 1 ? matches[0]?.id : undefined;
}

export function reloadChannelSetupPluginRegistryForChannel(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channel: string;
  pluginId?: string;
  workspaceDir?: string;
}): void {
  const activeRegistry = getActivePluginChannelRegistry();
  const scopedPluginId = resolveScopedChannelPluginId({
    cfg: params.cfg,
    channel: params.channel,
    pluginId: params.pluginId,
    workspaceDir: params.workspaceDir,
  });
  // On low-memory hosts, the empty-registry fallback should only recover the selected
  // plugin when we have a trusted channel -> plugin mapping. Otherwise fall back
  // to an unscoped reload instead of trusting manifest-declared channel ids.
  const onlyPluginIds =
    activeRegistry?.plugins.length || !scopedPluginId ? undefined : [scopedPluginId];
  loadChannelSetupPluginRegistry({
    ...params,
    onlyPluginIds,
  });
}

export function loadChannelSetupPluginRegistrySnapshotForChannel(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channel: string;
  pluginId?: string;
  workspaceDir?: string;
}): PluginRegistry {
  const scopedPluginId = resolveScopedChannelPluginId({
    cfg: params.cfg,
    channel: params.channel,
    pluginId: params.pluginId,
    workspaceDir: params.workspaceDir,
  });
  return loadChannelSetupPluginRegistry({
    ...params,
    ...(scopedPluginId ? { onlyPluginIds: [scopedPluginId] } : {}),
    activate: false,
  });
}
