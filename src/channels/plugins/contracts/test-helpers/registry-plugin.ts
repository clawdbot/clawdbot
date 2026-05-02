import type { ChannelId } from "../../channel-id.types.js";
import { listBundledChannelPluginIds } from "./bundled-channel-plugin-loader.js";

type PluginContractRef = {
  id: ChannelId;
};

function getBundledChannelPluginIdsForShard(params: {
  shardIndex: number;
  shardCount: number;
}): readonly ChannelId[] {
  return listBundledChannelPluginIds().filter(
    (_id, index) => index % params.shardCount === params.shardIndex,
  );
}

export function getPluginContractRegistryShardRefs(params: {
  shardIndex: number;
  shardCount: number;
}): PluginContractRef[] {
  return getBundledChannelPluginIdsForShard(params).map((id) => ({ id }));
}
