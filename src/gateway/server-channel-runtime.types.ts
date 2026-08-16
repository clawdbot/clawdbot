// Gateway channel runtime snapshot types.
// Exposes read-only channel/account state to status and server-method surfaces.
import type { ChannelId, ChannelAccountSnapshot } from "../channels/plugins/types.public.js";

/** Snapshot of channel runtime state keyed by channel and account id. */
export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};

export type StartChannelOptions = {
  /**
   * Include accounts that the manager already knows about in addition to the
   * plugin's current account listing.
   *
   * Channel hot reload uses this as a safety net for externally managed account stores.
   */
  includeKnownAccounts?: boolean;
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
  deferAccountStartUntil?: Promise<void>;
  manual?: boolean;
};
