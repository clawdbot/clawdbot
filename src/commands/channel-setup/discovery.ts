import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChatChannels } from "../../channels/chat-meta.js";
import { type ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { isChannelVisibleInSetup } from "../../channels/plugins/exposure.js";
import { normalizeChannelMeta } from "../../channels/plugins/meta-normalization.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelMeta } from "../../channels/plugins/types.public.js";
import { isStaticallyChannelConfigured } from "../../config/channel-configured-shared.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listPluginContributionIds,
  loadPluginRegistrySnapshot,
} from "../../plugins/plugin-registry.js";
import type { ChannelChoice } from "../onboard-types.js";
import {
  listSetupDiscoveryChannelPluginCatalogEntries,
  listTrustedChannelPluginCatalogEntries,
} from "./trusted-catalog.js";

type ChannelCatalogEntry = {
  id: ChannelChoice;
  meta: ChannelMeta;
};

export function shouldShowChannelInSetup(
  meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">,
): boolean {
  return isChannelVisibleInSetup(meta);
}

export type ResolvedChannelSetupEntries = {
  entries: ChannelCatalogEntry[];
  installedCatalogEntries: ChannelPluginCatalogEntry[];
  installableCatalogEntries: ChannelPluginCatalogEntry[];
  installedCatalogById: Map<ChannelChoice, ChannelPluginCatalogEntry>;
  installableCatalogById: Map<ChannelChoice, ChannelPluginCatalogEntry>;
};

function resolveWorkspaceDir(cfg: OpenClawConfig, workspaceDir?: string): string | undefined {
  return workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

export function listManifestInstalledChannelIds(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Set<ChannelChoice> {
  const resolvedConfig = applyPluginAutoEnable({
    config: params.cfg,
    env: params.env ?? process.env,
  }).config;
  const workspaceDir = resolveWorkspaceDir(resolvedConfig, params.workspaceDir);
  const index = loadPluginRegistrySnapshot({
    config: resolvedConfig,
    workspaceDir,
    env: params.env ?? process.env,
  });
  return new Set(
    listPluginContributionIds({
      index,
      contribution: "channels",
      config: resolvedConfig,
      workspaceDir,
      env: params.env ?? process.env,
    }).map((channelId) => channelId as ChannelChoice),
  );
}

export function isCatalogChannelInstalled(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return listManifestInstalledChannelIds(params).has(params.entry.id as ChannelChoice);
}

export function resolveChannelSetupEntries(params: {
  cfg: OpenClawConfig;
  installedPlugins: ChannelPlugin[];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedChannelSetupEntries {
  const workspaceDir = resolveWorkspaceDir(params.cfg, params.workspaceDir);
  const manifestInstalledIds = listManifestInstalledChannelIds({
    cfg: params.cfg,
    workspaceDir,
    env: params.env,
  });
  const installedPluginIds = new Set(params.installedPlugins.map((plugin) => plugin.id));
  // Discovery keeps workspace-only install candidates visible, while the
  // installed bucket must still reflect what setup can safely auto-load.
  const installedCatalogEntriesSource = listTrustedChannelPluginCatalogEntries({
    cfg: params.cfg,
    workspaceDir,
    env: params.env,
  });
  const installableCatalogEntriesSource = listSetupDiscoveryChannelPluginCatalogEntries({
    cfg: params.cfg,
    workspaceDir,
    env: params.env,
  });
  const installedCatalogEntries = installedCatalogEntriesSource
    .filter(
      (entry) =>
        !installedPluginIds.has(entry.id) &&
        manifestInstalledIds.has(entry.id as ChannelChoice) &&
        shouldShowChannelInSetup(entry.meta),
    )
    .map((entry) =>
      Object.assign({}, entry, {
        meta: normalizeChannelMeta({ id: entry.id as ChannelChoice, meta: entry.meta }),
      }),
    );
  const installableCatalogEntries = installableCatalogEntriesSource
    .filter(
      (entry) =>
        !installedPluginIds.has(entry.id) &&
        !manifestInstalledIds.has(entry.id as ChannelChoice) &&
        !isStaticallyChannelConfigured(params.cfg, entry.id, params.env ?? process.env) &&
        shouldShowChannelInSetup(entry.meta),
    )
    .map((entry) =>
      Object.assign({}, entry, {
        meta: normalizeChannelMeta({ id: entry.id as ChannelChoice, meta: entry.meta }),
      }),
    );

  const metaById = new Map<string, ChannelMeta>();
  for (const meta of listChatChannels()) {
    metaById.set(
      meta.id,
      normalizeChannelMeta({
        id: meta.id,
        meta,
      }),
    );
  }
  for (const plugin of params.installedPlugins) {
    metaById.set(
      plugin.id,
      normalizeChannelMeta({
        id: plugin.id,
        meta: plugin.meta,
        existing: metaById.get(plugin.id),
      }),
    );
  }
  for (const entry of installedCatalogEntries) {
    if (!metaById.has(entry.id)) {
      metaById.set(
        entry.id,
        normalizeChannelMeta({
          id: entry.id as ChannelChoice,
          meta: entry.meta,
          existing: metaById.get(entry.id),
        }),
      );
    }
  }
  for (const entry of installableCatalogEntries) {
    if (!metaById.has(entry.id)) {
      metaById.set(
        entry.id,
        normalizeChannelMeta({
          id: entry.id as ChannelChoice,
          meta: entry.meta,
          existing: metaById.get(entry.id),
        }),
      );
    }
  }

  return {
    entries: Array.from(metaById, ([id, meta]) => ({
      id: id as ChannelChoice,
      meta,
    })).filter((entry) => shouldShowChannelInSetup(entry.meta)),
    installedCatalogEntries,
    installableCatalogEntries,
    installedCatalogById: new Map(
      installedCatalogEntries.map((entry) => [entry.id as ChannelChoice, entry]),
    ),
    installableCatalogById: new Map(
      installableCatalogEntries.map((entry) => [entry.id as ChannelChoice, entry]),
    ),
  };
}
