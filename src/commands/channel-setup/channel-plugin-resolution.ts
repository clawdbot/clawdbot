import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  listChannelPluginCatalogEntries,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./plugin-install.js";
import {
  getTrustedChannelPluginCatalogEntry,
  listTrustedChannelPluginCatalogEntries,
} from "./trusted-catalog.js";

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
  pluginInstalled: boolean;
  supportsRequestedCapability?: boolean;
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

function resolveCatalogChannelEntry(raw: string, cfg: OpenClawConfig | null) {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return undefined;
  }
  const entries = cfg
    ? listTrustedChannelPluginCatalogEntries({
        cfg,
        workspaceDir: resolveWorkspaceDir(cfg),
      })
    : listChannelPluginCatalogEntries({ excludeWorkspace: true });
  return entries.find((entry) => {
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
  supports: (plugin: ChannelPlugin) => boolean,
): ChannelPlugin | undefined {
  const runtimePlugin = snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin;
  if (runtimePlugin) {
    return runtimePlugin;
  }
  const setupPlugin = snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin;
  return setupPlugin && supports(setupPlugin) ? setupPlugin : undefined;
}

function loadScopedChannelPlugin(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channelId: ChannelId;
  supports: (plugin: ChannelPlugin) => boolean;
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
  return findScopedChannelPlugin(snapshot, params.channelId, params.supports);
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
  const catalogEntry =
    (params.rawChannel ? resolveCatalogChannelEntry(params.rawChannel, nextCfg) : undefined) ??
    (params.channelId
      ? getTrustedChannelPluginCatalogEntry(params.channelId, {
          cfg: nextCfg,
          workspaceDir,
        })
      : undefined);
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
      pluginInstalled: false,
    };
  }

  const existing = getChannelPlugin(channelId);
  if (existing) {
    return {
      cfg: nextCfg,
      channelId,
      plugin: existing,
      catalogEntry,
      configChanged: false,
      pluginInstalled: false,
      supportsRequestedCapability: supports(existing),
    };
  }

  const resolvedPluginId = catalogEntry?.pluginId;
  if (catalogEntry) {
    const scoped = loadScopedChannelPlugin({
      cfg: nextCfg,
      runtime: params.runtime,
      channelId,
      supports,
      pluginId: resolvedPluginId,
      workspaceDir,
    });
    if (scoped) {
      return {
        cfg: nextCfg,
        channelId,
        plugin: scoped,
        catalogEntry,
        configChanged: false,
        pluginInstalled: false,
        supportsRequestedCapability: supports(scoped),
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
            supports,
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
        pluginInstalled: installResult.installed,
        supportsRequestedCapability: installedPlugin ? supports(installedPlugin) : undefined,
      };
    }
  }

  return {
    cfg: nextCfg,
    channelId,
    plugin: existing,
    catalogEntry,
    configChanged: false,
    pluginInstalled: false,
  };
}
