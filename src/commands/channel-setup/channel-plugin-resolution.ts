// Resolves or installs channel plugins needed by setup/onboarding flows.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { resolveChannelSetupOwner } from "./owner.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./plugin-install.js";
import {
  getTrustedChannelPluginCatalogEntry,
  listTrustedChannelPluginCatalogEntries,
} from "./trusted-catalog.js";

type ResolveInstallableChannelPluginResult = {
  cfg: OpenClawConfig;
  channelId?: ChannelId;
  plugin?: ChannelPlugin;
  catalogEntry?: ChannelPluginCatalogEntry;
  configChanged: boolean;
  pluginInstalled: boolean;
  supportsRequestedCapability?: boolean;
};

function resolveCatalogChannelEntry(raw: string, cfg: OpenClawConfig, workspaceDir?: string) {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return undefined;
  }
  const entries = listTrustedChannelPluginCatalogEntries({ cfg, workspaceDir });
  return entries.find((entry) => {
    if (normalizeOptionalLowercaseString(entry.id) === trimmed) {
      return true;
    }
    return (entry.meta.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === trimmed,
    );
  });
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

  // Installation may replace config, but discovery must retain this operation's workspace.
  const { workspaceDir } = resolveChannelSetupOwner(nextCfg, params.agentId);
  let catalogEntry =
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
    (catalogEntry ? (normalizeChannelId(catalogEntry.id) ?? catalogEntry.id) : undefined);
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
  let plugin = getLoadedChannelPlugin(channelId);
  let pluginInstalled = false;
  if (!plugin && catalogEntry) {
    const loadPlugin = (pluginId?: string): ChannelPlugin | undefined => {
      const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
        cfg: nextCfg,
        runtime: params.runtime,
        channel: channelId,
        ...(pluginId ? { pluginId } : {}),
        workspaceDir,
      });
      const runtimePlugin = snapshot.channels.find(
        (entry) => entry.plugin.id === channelId,
      )?.plugin;
      if (runtimePlugin) {
        return runtimePlugin;
      }
      const setupPlugin = snapshot.channelSetups.find(
        (entry) => entry.plugin.id === channelId,
      )?.plugin;
      return setupPlugin && supports(setupPlugin) ? setupPlugin : undefined;
    };
    plugin = loadPlugin(catalogEntry.pluginId);

    if (!plugin && params.allowInstall !== false) {
      const installResult = await ensureChannelSetupPluginInstalled({
        cfg: nextCfg,
        entry: catalogEntry,
        prompter: params.prompter ?? createClackPrompter(),
        runtime: params.runtime,
        workspaceDir,
      });
      nextCfg = installResult.cfg;
      const installedPluginId = installResult.pluginId ?? catalogEntry.pluginId;
      pluginInstalled = installResult.installed;
      if (pluginInstalled) {
        plugin = loadPlugin(installedPluginId);
      }
      if (installedPluginId && catalogEntry.pluginId !== installedPluginId) {
        catalogEntry = { ...catalogEntry, pluginId: installedPluginId };
      }
    }
  }

  return {
    cfg: nextCfg,
    channelId,
    plugin,
    catalogEntry,
    configChanged: nextCfg !== params.cfg,
    pluginInstalled,
    supportsRequestedCapability: plugin ? supports(plugin) : undefined,
  };
}
