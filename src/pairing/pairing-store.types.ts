import type { ChannelId } from "../channels/plugins/channel-id.types.js";
import type { ChannelPairingAdapter } from "../channels/plugins/pairing.types.js";

export type PairingChannel = ChannelId;

export type ReadChannelAllowFromStoreForAccount = (params: {
  channel: PairingChannel;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<string[]>;

export type UpsertChannelPairingRequestForAccount = (params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
}) => Promise<{ code: string; created: boolean }>;
