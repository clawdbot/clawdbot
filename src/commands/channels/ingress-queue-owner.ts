// Resolves which plugin owns a channel's durable ingress rows, for operator commands.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import {
  getRegisteredChannelOwnerPluginId,
  normalizeAnyChannelId,
} from "../../channels/registry.js";

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

/**
 * Resolves the account id a channel's durable ingress rows are stored under.
 *
 * The queue name has two halves and both are composed by the plugin, not by the
 * operator. The owner id above is the first; this is the second. WhatsApp opens its
 * queue with `hashNamespacePart(accountId)`, so addressing its rows by the configured
 * account id selects nothing at all - the same defect as the channel half, one field
 * over. Only a plugin that transforms the id declares `resolveDurableAccountKey`;
 * for every other channel this returns the account id unchanged.
 */
export function resolveChannelIngressQueueAccountKey(params: {
  channelId: string;
  accountId: string;
  plugin?: Pick<ChannelPlugin, "config"> | undefined;
}): string {
  // Canonicalize first. The owner half resolves through the alias-aware registry key,
  // and `getChannelPlugin` is by canonical id only — so without this an operator typing
  // a documented alias got the owner from one channel and the account key from no
  // channel at all, addressing half of one key and half of another.
  const canonicalId = normalizeAnyChannelId(params.channelId) ?? params.channelId;
  const plugin = params.plugin ?? getChannelPlugin(canonicalId);
  const stored = plugin?.config?.resolveDurableAccountKey?.(params.accountId);
  return normalizeOptionalString(stored) ?? params.accountId;
}
