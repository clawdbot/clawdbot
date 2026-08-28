// Shared type contracts for pairing challenge and channel binding records.
import type { ChannelId } from "../channels/plugins/channel-id.types.js";
import type { ChannelPairingAdapter } from "../channels/plugins/pairing.types.js";

// Pairing store contracts shared by channel ingress and approval flows. Pairing
// channels use channel ids but keep a narrower alias for readability.
export type PairingChannel = ChannelId;

export type PairingRequestRecord = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};

/** Reads approved ids from a channel/account allowFrom store. */
export type ReadChannelAllowFromStoreForAccount = (params: {
  channel: PairingChannel;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<string[]>;

/** Deletes one approved id from a channel/account allowFrom store. */
export type RemoveChannelAllowFromStoreEntryForAccount = (params: {
  channel: PairingChannel;
  entry: string | number;
  accountId: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
}) => Promise<{ changed: boolean; allowFrom: string[] }>;

/** Creates or reuses a pending pairing request for one channel account. */
export type UpsertChannelPairingRequestForAccount = (params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
}) => Promise<{ code: string; created: boolean }>;
