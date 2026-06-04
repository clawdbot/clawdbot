import type { ChannelId, ChannelAccountSnapshot } from "../channels/plugins/types.public.js";

// Channel runtime snapshots are the read-only Gateway view of channel/account
// state used by status and server-method surfaces.
/** Snapshot of channel runtime state keyed by channel and account id. */
export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};
