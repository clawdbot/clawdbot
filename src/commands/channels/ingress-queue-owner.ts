// Resolves which plugin owns a channel's durable ingress rows, for operator commands.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import {
  getRegisteredChannelOwnerPluginId,
  normalizeAnyChannelId,
} from "../../channels/registry.js";

/** Both halves of the queue name a channel account's durable rows are stored under. */
type ChannelIngressQueueKey = {
  channelId: string;
  accountId: string;
};

/**
 * Resolves the whole queue name, never one half of it.
 *
 * The two halves used to be two functions, and a caller resolved one and forgot the
 * other within a day: the owner half went through the alias-aware registry key while
 * the account half did not, so an operator typing a documented alias addressed half of
 * one key and half of another. Returning the pair is what keeps them together: a caller
 * that passes the result whole cannot substitute one field, while spreading it can, so
 * both production callers pass it whole.
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
 *
 * The queue is one per PLUGIN, while a manifest may declare several channels for it
 * (`loader-channel-setup.ts:231`), and the stored rows carry no channel dimension of
 * their own. Two consequences worth stating plainly:
 *
 * - Removing one channel's account on a plugin that serves several would discard the
 *   sibling channels' rows for that account id as well. There is nothing to narrow it
 *   by; the row simply does not record which channel it arrived on. No bundled plugin
 *   is in that shape today - of the 27 manifests declaring channels, none declares
 *   more than one.
 * - Doctor's ingress lane still keys on the channel id
 *   (`state-migrations.plugin-doctor-context.ts:230` and `:244`) and is deliberately
 *   left alone here. Not because its `channelId` is untouchable - the SDK-visible
 *   selector is the separate `access.channelId` at `:236`, which is what a plugin
 *   matches on (`extensions/line/doctor-contract-api.ts:18`) - but because the
 *   contract hands out "one entry per manifest-declared channel"
 *   (`plugins/doctor-contract-module.ts:42`) while the queue underneath is one per
 *   plugin, so re-keying it would make N lanes alias a single queue. That is a
 *   contract decision, not a call-site fix.
 */
export function resolveChannelIngressQueueKey(params: {
  channelId: string;
  accountId: string;
  catalogPluginId?: string | undefined;
  plugin?: Pick<ChannelPlugin, "config"> | undefined;
}): ChannelIngressQueueKey {
  // Canonicalize before the plugin lookup: `getChannelPlugin` is by canonical id only,
  // while the owner half accepts aliases, and both halves must mean the same channel.
  const canonicalId = normalizeAnyChannelId(params.channelId) ?? params.channelId;
  const plugin = params.plugin ?? getChannelPlugin(canonicalId);
  // A declared resolver is authoritative, including when it returns an empty string:
  // the write side normalizes empty to "default" too, so falling back to the configured
  // id here would be the one case that silently addresses a different queue.
  const storedAccountId = plugin?.config?.resolveDurableAccountKey?.(params.accountId);
  return {
    channelId:
      getRegisteredChannelOwnerPluginId(params.channelId) ??
      normalizeOptionalString(params.catalogPluginId) ??
      params.channelId,
    accountId: storedAccountId ?? params.accountId,
  };
}
