// Gateway channel runtime snapshot types.
// Exposes read-only channel/account state to status and server-method surfaces.
import type { ChannelId, ChannelAccountSnapshot } from "../channels/plugins/types.public.js";

/** Snapshot of channel runtime state keyed by channel and account id. */
export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};

export type StartChannelOptions = {
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
  /** Reload leaves snapshot-cold accounts stopped without bypassing credential-file reinspection. */
  skipUnavailableAccounts?: boolean;
  deferAccountStartUntil?: Promise<void>;
  manual?: boolean;
};
