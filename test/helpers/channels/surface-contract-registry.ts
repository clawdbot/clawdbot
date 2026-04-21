import type { ChannelId } from "../../../src/channels/plugins/channel-id.types.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  getBundledChannelPlugin,
  listBundledChannelPluginIds,
  listBundledChannelPlugins,
} from "./bundled-channel-plugin-loader.js";
import { channelPluginSurfaceKeys, type ChannelPluginSurface } from "./manifest.js";

type SurfaceContractEntry = {
  id: string;
  plugin: Pick<
    ChannelPlugin,
    | "id"
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway"
  >;
  surfaces: readonly ChannelPluginSurface[];
};

type ThreadingContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "threading">;
};

type DirectoryContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage: "lookups" | "presence";
  cfg?: OpenClawConfig;
  accountId?: string;
};

let surfaceContractRegistryCache: SurfaceContractEntry[] | undefined;
const surfaceContractEntryCache = new Map<ChannelId, SurfaceContractEntry | null>();
let threadingContractRegistryCache: ThreadingContractEntry[] | undefined;
let directoryContractRegistryCache: DirectoryContractEntry[] | undefined;

const threadingContractPluginIds = new Set<ChannelId>([
  "bluebubbles",
  "discord",
  "googlechat",
  "matrix",
  "mattermost",
  "msteams",
  "slack",
  "telegram",
  "zalo",
  "zalouser",
]);

const directoryContractPluginIds = new Set<ChannelId>([
  "discord",
  "feishu",
  "googlechat",
  "irc",
  "line",
  "matrix",
  "mattermost",
  "msteams",
  "slack",
  "synology-chat",
  "telegram",
  "whatsapp",
  "zalo",
  "zalouser",
]);

function toSurfaceContractEntry(plugin: ChannelPlugin): SurfaceContractEntry {
  return {
    id: plugin.id,
    plugin,
    surfaces: channelPluginSurfaceKeys.filter((surface) => Boolean(plugin[surface])),
  };
}

function getBundledChannelPluginIdsForShard(params: {
  shardIndex: number;
  shardCount: number;
}): readonly ChannelId[] {
  return listBundledChannelPluginIds().filter(
    (_id, index) => index % params.shardCount === params.shardIndex,
  );
}

function getSurfaceContractEntry(id: ChannelId): SurfaceContractEntry | undefined {
  if (surfaceContractEntryCache.has(id)) {
    return surfaceContractEntryCache.get(id) ?? undefined;
  }
  const plugin = getBundledChannelPlugin(id);
  const entry = plugin ? toSurfaceContractEntry(plugin) : null;
  surfaceContractEntryCache.set(id, entry);
  return entry ?? undefined;
}

export function getSurfaceContractRegistry(): SurfaceContractEntry[] {
  surfaceContractRegistryCache ??= listBundledChannelPlugins().map(toSurfaceContractEntry);
  return surfaceContractRegistryCache;
}

export function getSurfaceContractRegistryShard(params: {
  shardIndex: number;
  shardCount: number;
}): SurfaceContractEntry[] {
  return getBundledChannelPluginIdsForShard(params).flatMap((id) => {
    const entry = getSurfaceContractEntry(id);
    return entry ? [entry] : [];
  });
}

export function getThreadingContractRegistry(): ThreadingContractEntry[] {
  threadingContractRegistryCache ??= listBundledChannelPluginIds()
    .filter((id) => threadingContractPluginIds.has(id))
    .flatMap((id) => {
      const entry = getSurfaceContractEntry(id);
      return entry && entry.surfaces.includes("threading")
        ? [
            {
              id: entry.id,
              plugin: entry.plugin,
            },
          ]
        : [];
    });
  return threadingContractRegistryCache;
}

export function getThreadingContractRegistryShard(params: {
  shardIndex: number;
  shardCount: number;
}): ThreadingContractEntry[] {
  return getBundledChannelPluginIdsForShard(params)
    .filter((id) => threadingContractPluginIds.has(id))
    .flatMap((id) => {
      const entry = getSurfaceContractEntry(id);
      return entry && entry.surfaces.includes("threading")
        ? [
            {
              id: entry.id,
              plugin: entry.plugin,
            },
          ]
        : [];
    });
}

const directoryPresenceOnlyIds = new Set(["whatsapp", "zalouser"]);

export function getDirectoryContractRegistry(): DirectoryContractEntry[] {
  directoryContractRegistryCache ??= listBundledChannelPluginIds()
    .filter((id) => directoryContractPluginIds.has(id))
    .flatMap((id) => {
      const entry = getSurfaceContractEntry(id);
      return entry && entry.surfaces.includes("directory")
        ? [
            {
              id: entry.id,
              plugin: entry.plugin,
              coverage: directoryPresenceOnlyIds.has(entry.id) ? "presence" : "lookups",
            },
          ]
        : [];
    });
  return directoryContractRegistryCache;
}

export function getDirectoryContractRegistryShard(params: {
  shardIndex: number;
  shardCount: number;
}): DirectoryContractEntry[] {
  return getBundledChannelPluginIdsForShard(params)
    .filter((id) => directoryContractPluginIds.has(id))
    .flatMap((id) => {
      const entry = getSurfaceContractEntry(id);
      return entry && entry.surfaces.includes("directory")
        ? [
            {
              id: entry.id,
              plugin: entry.plugin,
              coverage: directoryPresenceOnlyIds.has(entry.id) ? "presence" : "lookups",
            },
          ]
        : [];
    });
}
