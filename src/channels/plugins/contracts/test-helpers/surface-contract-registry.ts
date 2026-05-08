import type { ChannelId } from "../../channel-id.types.js";
import { listBundledChannelPluginIds } from "./bundled-channel-plugin-loader.js";

type ThreadingContractRef = {
  id: ChannelId;
};

type DirectoryContractRef = {
  id: ChannelId;
  coverage: "lookups" | "presence";
};

const threadingContractPluginIds = new Set<ChannelId>([
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

function getBundledChannelPluginIdsForShard(params: {
  shardIndex: number;
  shardCount: number;
}): readonly ChannelId[] {
  return listBundledChannelPluginIds().filter(
    (_id, index) => index % params.shardCount === params.shardIndex,
  );
}

export function getSurfaceContractRegistryShardIds(params: {
  shardIndex: number;
  shardCount: number;
}): readonly ChannelId[] {
  return getBundledChannelPluginIdsForShard(params);
}

export function getThreadingContractRegistryShardRefs(params: {
  shardIndex: number;
  shardCount: number;
}): ThreadingContractRef[] {
  return getBundledChannelPluginIdsForShard(params)
    .filter((id) => threadingContractPluginIds.has(id))
    .map((id) => ({ id }));
}

const directoryPresenceOnlyIds = new Set(["whatsapp", "zalouser"]);

export function getDirectoryContractRegistryShardRefs(params: {
  shardIndex: number;
  shardCount: number;
}): DirectoryContractRef[] {
  return getBundledChannelPluginIdsForShard(params)
    .filter((id) => directoryContractPluginIds.has(id))
    .map((id) => ({
      id,
      coverage: directoryPresenceOnlyIds.has(id) ? "presence" : "lookups",
    }));
}
