import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEnableState } from "../../plugins/config-state.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./plugin-install.js";

type ChannelPluginSnapshot = {
  channels: Array<{ plugin: ChannelPlugin }>;
  channelSetups: Array<{ plugin: ChannelPlugin }>;
};

type ResolveInstallableChannelPluginResult = {
  cfg: OpenClawConfig;
  channelId?: ChannelId;
  plugin?: ChannelPlugin;
  catalogEntry?: ChannelPluginCatalogEntry;
  configChanged: boolean;
};

function resolveWorkspaceDir(cfg: OpenClawConfig) {
  return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function resolveResolvedChannelId(params: {
  rawChannel?: string | null;
  catalogEntry?: ChannelPluginCatalogEntry;
}): ChannelId | undefined {
  const normalized = normalizeChannelId(params.rawChannel);
  if (normalized) {
    return normalized;
  }
  if (!params.catalogEntry) {
    return undefined;
  }
  return normalizeChannelId(params.catalogEntry.id) ?? (params.catalogEntry.id as ChannelId);
}

export function resolveCatalogChannelEntry(raw: string, cfg: OpenClawConfig | null) {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return undefined;
  }
  const workspaceDir = cfg ? resolveWorkspaceDir(cfg) : undefined;
  return listChannelPluginCatalogEntries({ workspaceDir }).find((entry) => {
    if (normalizeOptionalLowercaseString(entry.id) === trimmed) {
      return true;
    }
    return (entry.meta.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === trimmed,
    );
  });
}

function findScopedChannelPlugin(
  snapshot: ChannelPluginSnapshot,
  channelId: ChannelId,
): ChannelPlugin | undefined {
  return (
    snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin ??
    snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin
  );
}

function isTrustedWorkspaceChannelCatalogEntry(
  entry: ChannelPluginCatalogEntry | undefined,
  cfg: OpenClawConfig,
): boolean {
  if (entry?.origin !== "workspace") {
    return true;
  }
  if (!entry.pluginId) {
    return false;
  }
  return resolveEnableState(entry.pluginId, "workspace", normalizePluginsConfig(cfg.plugins))
    .enabled;
}

function resolveTrustedCatalogEntry(params: {
  rawChannel?: string | null;
  channelId?: ChannelId;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  catalogEntry?: ChannelPluginCatalogEntry;
}): ChannelPluginCatalogEntry | undefined {
  if (isTrustedWorkspaceChannelCatalogEntry(params.catalogEntry, params.cfg)) {
    return params.catalogEntry;
  }
  if (params.rawChannel) {
    const trimmed = normalizeOptionalLowercaseString(params.rawChannel);
    if (!trimmed) {
      return undefined;
    }
    return listChannelPluginCatalogEntries({
      workspaceDir: params.workspaceDir,
      excludeWorkspace: true,
    }).find((entry) => {
      if (normalizeOptionalLowercaseString(entry.id) === trimmed) {
        return true;
      }
      return (entry.meta.aliases ?? []).some(
        (alias) => normalizeOptionalLowercaseString(alias) === trimmed,
      );
    });
  }
  if (!params.channelId) {
    return undefined;
  }
  return getChannelPluginCatalogEntry(params.channelId, {
    workspaceDir: params.workspaceDir,
    excludeWorkspace: true,
  });
}

function loadScopedChannelPlugin(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channelId: ChannelId;
  pluginId?: string;
  workspaceDir?: string;
}): ChannelPlugin | undefined {
  const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
    cfg: params.cfg,
    runtime: params.runtime,
    channel: params.channelId,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    workspaceDir: params.workspaceDir,
  });
  return findScopedChannelPlugin(snapshot, params.channelId);
}

export async function resolveInstallableChannelPlugin(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  rawChannel?: string | null;
  channelId?: ChannelId;
  allowInstall?: boolean;
  prompter?: WizardPrompter;
  supports?: (plugin: ChannelPlugin) => boolean;
}): Promise<ResolveInstallableChannelPluginResult> {
  const supports = params.supports ?? (() => true);
  let nextCfg = params.cfg;
  const workspaceDir = resolveWorkspaceDir(nextCfg);
  const unresolvedCatalogEntry =
    (params.rawChannel ? resolveCatalogChannelEntry(params.rawChannel, nextCfg) : undefined) ??
    (params.channelId
      ? getChannelPluginCatalogEntry(params.channelId, {
          workspaceDir,
        })
      : undefined);
  const catalogEntry = resolveTrustedCatalogEntry({
    rawChannel: params.rawChannel,
    channelId: params.channelId,
    cfg: nextCfg,
    workspaceDir,
    catalogEntry: unresolvedCatalogEntry,
  });
  const channelId =
    params.channelId ??
    resolveResolvedChannelId({
      rawChannel: params.rawChannel,
      catalogEntry,
    });
  if (!channelId) {
    return {
      cfg: nextCfg,
      catalogEntry,
      configChanged: false,
    };
  }

  const existing = getChannelPlugin(channelId);
  if (existing && supports(existing)) {
    return {
      cfg: nextCfg,
      channelId,
      plugin: existing,
      catalogEntry,
      configChanged: false,
    };
  }

  const resolvedPluginId = catalogEntry?.pluginId;
  if (catalogEntry) {
    const scoped = loadScopedChannelPlugin({
      cfg: nextCfg,
      runtime: params.runtime,
      channelId,
      pluginId: resolvedPluginId,
      workspaceDir,
    });
    if (scoped && supports(scoped)) {
      return {
        cfg: nextCfg,
        channelId,
        plugin: scoped,
        catalogEntry,
        configChanged: false,
      };
    }

    if (params.allowInstall !== false) {
      const installResult = await ensureChannelSetupPluginInstalled({
        cfg: nextCfg,
        entry: catalogEntry,
        prompter: params.prompter ?? createClackPrompter(),
        runtime: params.runtime,
        workspaceDir,
      });
      nextCfg = installResult.cfg;
      const installedPluginId = installResult.pluginId ?? resolvedPluginId;
      const installedPlugin = installResult.installed
        ? loadScopedChannelPlugin({
            cfg: nextCfg,
            runtime: params.runtime,
            channelId,
            pluginId: installedPluginId,
            workspaceDir: resolveWorkspaceDir(nextCfg),
          })
        : undefined;
      return {
        cfg: nextCfg,
        channelId,
        plugin: installedPlugin ?? existing,
        catalogEntry:
          installedPluginId && catalogEntry.pluginId !== installedPluginId
            ? { ...catalogEntry, pluginId: installedPluginId }
            : catalogEntry,
        configChanged: nextCfg !== params.cfg,
      };
    }
  }

  return {
    cfg: nextCfg,
    channelId,
    plugin: existing,
    catalogEntry,
    configChanged: false,
  };
}
