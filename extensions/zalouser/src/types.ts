// Zalouser type declarations define plugin contracts.
import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import type { Style } from "./zca-constants.js";

export type ZcaFriend = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type ZaloGroup = {
  groupId: string;
  name: string;
  memberCount?: number;
};

export type ZaloGroupMember = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type ZaloEventMessage = {
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  idTo: string;
  msgType: string;
  st: number;
  at: number;
  cmd: number;
  ts: string | number;
};

/**
 * Surface a single inbound attachment from a Zalo message. Currently we only
 * extract photos because that is the most common attachment type Vietnamese
 * customer-support bots receive (users sending a photo of a device serial
 * number, ID card, error screen, etc.). Other attachment kinds (audio, file,
 * video) can be added later without breaking the existing tuple shape.
 */
export type ZaloInboundMedia = {
  kind: "image";
  /** Public Zalo CDN URL the media can be downloaded from. No auth required. */
  url: string;
  /** Optional thumbnail URL (smaller version of the same image). */
  thumbUrl?: string;
};

export type ZaloInboundMessage = {
  threadId: string;
  isGroup: boolean;
  senderId: string;
  senderName?: string;
  groupName?: string;
  content: string;
  commandContent?: string;
  timestampMs: number;
  msgId?: string;
  cliMsgId?: string;
  hasAnyMention?: boolean;
  wasExplicitlyMentioned?: boolean;
  canResolveExplicitMention?: boolean;
  implicitMention?: boolean;
  quotedGlobalMsgId?: string;
  quotedOwnerId?: string;
  quotedBody?: string;
  eventMessage?: ZaloEventMessage;
  /**
   * Set when the inbound message carries an attachment (photo today). The
   * channel runtime downloads the bytes via `core.channel.media.saveRemoteMedia`
   * before passing the message to the agent, so the agent receives the photo
   * as a native vision content block - no separate tool call required.
   * Undefined for plain text messages.
   */
  media?: ZaloInboundMedia;
  raw: unknown;
};

export type ZcaUserInfo = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type ZaloSendOptions = {
  profile?: string;
  mediaUrl?: string;
  caption?: string;
  isGroup?: boolean;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  textMode?: "markdown" | "plain";
  textChunkMode?: "length" | "newline";
  textChunkLimit?: number;
  textStyles?: Style[];
};

export type ZaloSendResult = {
  ok: boolean;
  messageId?: string;
  receipt: MessageReceipt;
  error?: string;
};

export type ZaloGroupContext = {
  groupId: string;
  name?: string;
  members?: string[];
};

export type ZaloAuthStatus = {
  connected: boolean;
  message: string;
};

type ZalouserToolConfig = { allow?: string[]; deny?: string[] };

export type ZalouserGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  tools?: ZalouserToolConfig;
};

type ZalouserSharedConfig = {
  enabled?: boolean;
  name?: string;
  profile?: string;
  dangerouslyAllowNameMatching?: boolean;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  historyLimit?: number;
  groupAllowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, ZalouserGroupConfig>;
  messagePrefix?: string;
  responsePrefix?: string;
};

export type ZalouserAccountConfig = ZalouserSharedConfig;

export type ZalouserConfig = ZalouserSharedConfig & {
  defaultAccount?: string;
  accounts?: Record<string, ZalouserAccountConfig>;
};

export type ResolvedZalouserAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  profile: string;
  authenticated: boolean;
  config: ZalouserAccountConfig;
};
