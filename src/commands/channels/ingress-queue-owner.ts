// Resolves which plugin owns a channel's durable ingress rows, for operator commands.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRegisteredChannelOwnerPluginId } from "../../channels/registry.js";

/**
 * Resolves the id a channel account's durable ingress rows are stored under.
 *
 * The plugin runtime opens an ingress queue with the plugin's own id - see the
 * `channelId: pluginId` it forces in `openChannelIngressQueue`, whose options type
 * omits `channelId` so a plugin cannot supply one - which is not the channel id
 * whenever an installed plugin's package id differs from the channel it serves.
 * Operator commands take a channel name, so each of them has to resolve the owner
 * before it touches that state, or it reads and writes a queue nothing owns.
 *
 * Prefer the live registration, since that is the plugin that opened the queue.
 * Fall back to the catalog entry that installed the plugin when it is no longer
 * registered, and finally to the channel id, which every bundled channel also
 * registers as its plugin id.
 */
export function resolveChannelIngressQueueOwnerId(params: {
  channelId: string;
  catalogPluginId?: string | undefined;
}): string {
  return (
    getRegisteredChannelOwnerPluginId(params.channelId) ??
    normalizeOptionalString(params.catalogPluginId) ??
    params.channelId
  );
}
