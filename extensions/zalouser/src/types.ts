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
  eventMessage?: ZaloEventMessage;
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

export type ZalouserToolConfig = { allow?: string[]; deny?: string[] };

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
