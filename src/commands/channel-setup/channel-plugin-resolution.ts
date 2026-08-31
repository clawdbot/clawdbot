// Resolves or installs channel plugins needed by setup/onboarding flows.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  listRawChannelPluginCatalogEntries,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
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

function resolveWorkspaceDir(cfg: OpenClawConfig, agentId?: string) {
  return resolveAgentWorkspaceDir(cfg, agentId ?? resolveDefaultAgentId(cfg));
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

function resolveCatalogChannelEntry(
  raw: string,
  cfg: OpenClawConfig | null,
  workspaceDir?: string,
) {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return undefined;
  }
  const entries = cfg
    ? listTrustedChannelPluginCatalogEntries({
        cfg,
        workspaceDir,
      })
    : listRawChannelPluginCatalogEntries({ excludeWorkspace: true });
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

/** Resolve an existing channel plugin, scoped setup plugin, or installable catalog entry. */
export async function resolveInstallableChannelPlugin(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  rawChannel?: string | null;
  channelId?: ChannelId;
  agentId?: string;
  allowInstall?: boolean;
  preferRegisteredPlugin?: boolean;
  prompter?: WizardPrompter;
  supports?: (plugin: ChannelPlugin) => boolean;
}): Promise<ResolveInstallableChannelPluginResult> {
  const supports = params.supports ?? (() => true);
  let nextCfg = params.cfg;
  const directChannelId = params.channelId ?? normalizeChannelId(params.rawChannel);
  const registeredPlugin =
    params.preferRegisteredPlugin && directChannelId
      ? getLoadedChannelPlugin(directChannelId)
      : undefined;
  if (params.preferRegisteredPlugin && directChannelId && registeredPlugin) {
    return {
      cfg: nextCfg,
      channelId: directChannelId,
      plugin: registeredPlugin,
      configChanged: false,
      pluginInstalled: false,
      supportsRequestedCapability: supports(registeredPlugin),
    };
  }

  const workspaceDir = resolveWorkspaceDir(nextCfg, params.agentId);
  const catalogEntry =
    (params.rawChannel
      ? resolveCatalogChannelEntry(params.rawChannel, nextCfg, workspaceDir)
      : undefined) ??
    (params.channelId
      ? getTrustedChannelPluginCatalogEntry(params.channelId, {
          cfg: nextCfg,
          workspaceDir,
        })
      : undefined);
  const channelId =
    directChannelId ??
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

  // Bundled plugin metadata is not runtime-bound; load it through the scoped registry
  // before returning a plugin that callers can execute.
  const existing = getLoadedChannelPlugin(channelId);
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
            workspaceDir: resolveWorkspaceDir(nextCfg, params.agentId),
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
