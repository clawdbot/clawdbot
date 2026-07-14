import type { Envelope, GuardAdapter, SignedReceipt } from "../protocol/index.js";
import type { ReefChannelConfig } from "./config-schema.js";

export interface ReefKeys {
  signing: { publicKey: string; secretKey: string };
  encryption: { publicKey: string; secretKey: string };
  auditKey: string;
  replayKey: string;
  keyEpoch: number;
}

export interface ReefAccount {
  accountId: "default";
  enabled: boolean;
  configured: boolean;
  config: ReefChannelConfig;
}

export interface RelayFriend {
  peer: string;
  status: "pending" | "active" | "blocked" | "reapprove_required";
  initiated_by: string;
  vouching_mutual: string | null;
  ed25519_pub: string;
  x25519_pub: string;
  key_epoch: number;
}

export interface InboxEntry {
  seq: number;
  peer: string;
  id: string;
  kind: "message" | "receipt";
  envelope?: Envelope;
  receipt?: SignedReceipt;
  ts: number;
}

export interface ReefDependencies {
  fetch?: typeof fetch;
  guard?: GuardAdapter;
  onIngress?: (message: ReefIngressMessage) => Promise<void>;
  onOwnerNotice?: (text: string) => Promise<void>;
}

export interface ReefIngressMessage {
  id: string;
  peer: string;
  text: string;
  thread?: string;
  replyTo?: string;
  provenance: string;
}
