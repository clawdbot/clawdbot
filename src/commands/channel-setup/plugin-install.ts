import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveDiscoverableScopedChannelPluginIds } from "../../plugins/channel-plugin-ids.js";
import { clearPluginDiscoveryCache } from "../../plugins/discovery.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createPluginLoaderLogger } from "../../plugins/logger.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  ensureOnboardingPluginInstalled,
  type OnboardingPluginInstallEntry,
  type OnboardingPluginInstallStatus,
} from "../onboarding-plugin-install.js";
import { getTrustedChannelPluginCatalogEntry } from "./trusted-catalog.js";

type InstallResult = {
  cfg: OpenClawConfig;
  installed: boolean;
  pluginId?: string;
  status: OnboardingPluginInstallStatus;
};

function toOnboardingPluginInstallEntry(
  entry: ChannelPluginCatalogEntry,
): OnboardingPluginInstallEntry {
  return {
    pluginId: entry.pluginId ?? entry.id,
    label: entry.meta.label,
    install: entry.install,
  };
}

export async function ensureChannelSetupPluginInstalled(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  promptInstall?: boolean;
}): Promise<InstallResult> {
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.cfg,
    entry: toOnboardingPluginInstallEntry(params.entry),
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
    ...(params.promptInstall !== undefined ? { promptInstall: params.promptInstall } : {}),
  });
  return {
    cfg: result.cfg,
    installed: result.installed,
    pluginId: result.pluginId,
    status: result.status,
  };
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
  installRuntimeDeps?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
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
    forceSetupOnlyChannelPlugins:
      params.forceSetupOnlyChannelPlugins ?? params.installRuntimeDeps === false,
    activate: params.activate,
    installBundledRuntimeDeps: params.installRuntimeDeps !== false,
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
  const matches = resolveDiscoverableScopedChannelPluginIds({
    config: params.cfg,
    channelIds: [params.channel],
    workspaceDir: params.workspaceDir,
    env: process.env,
    cache: false,
  });
  return matches.length === 1 ? matches[0] : undefined;
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
  installRuntimeDeps?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
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
