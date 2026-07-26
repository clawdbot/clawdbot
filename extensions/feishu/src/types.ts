// Feishu type declarations define plugin contracts.
import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import type { BaseProbeResult } from "openclaw/plugin-sdk/core";
import type { FeishuConfigSchema, FeishuAccountConfigSchema, z } from "./config-schema.js";
import type { MentionTarget } from "./mention-target.types.js";

export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;
export type FeishuAccountConfig = z.infer<typeof FeishuAccountConfigSchema>;

export type FeishuDomain = "feishu" | "lark" | (string & {});

export type FeishuDefaultAccountSelectionSource =
  | "explicit-default"
  | "mapped-default"
  | "fallback";
type FeishuAccountSelectionSource = "explicit" | FeishuDefaultAccountSelectionSource;

export type ResolvedFeishuAccount = {
  accountId: string;
  selectionSource: FeishuAccountSelectionSource;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
  /** Merged config (top-level defaults + account-specific overrides) */
  config: FeishuConfig;
};

export type FeishuIdType = "open_id" | "user_id" | "union_id" | "chat_id";

export type FeishuMessageContext = {
  chatId: string;
  messageId: string;
  replyTargetMessageId?: string;
  typingTargetMessageId?: string;
  suppressReplyTarget?: boolean;
  senderId: string;
  senderOpenId: string;
  senderName?: string;
  senderType: "user" | "bot";
  chatType: FeishuChatType;
  mentionedBot: boolean;
  hasAnyMention?: boolean;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  content: string;
  contentType: string;
  /** Mention forward targets (excluding the bot itself) */
  mentionTargets?: MentionTarget[];
};

export type FeishuSendResult = {
  messageId: string;
  chatId: string;
  receipt: MessageReceipt;
};

export type FeishuChatType = "p2p" | "group" | "topic_group" | "private";

export function isFeishuGroupChatType(chatType: FeishuChatType | undefined): boolean {
  return chatType === "group" || chatType === "topic_group";
}

export type FeishuMessageInfo = {
  messageId: string;
  chatId: string;
  chatType?: FeishuChatType;
  senderId?: string;
  senderOpenId?: string;
  senderType?: string;
  content: string;
  contentType: string;
  createTime?: number;
  /** Feishu thread ID (omt_xxx) — present when the message belongs to a topic thread. */
  threadId?: string;
};

export interface FeishuProbeResult extends BaseProbeResult {
  appId?: string;
  botName?: string;
  botOpenId?: string;
}

export type FeishuMediaInfo = {
  path?: string;
  contentType?: string;
  kind: Exclude<import("openclaw/plugin-sdk/media-runtime").MediaKind, "unknown">;
};

export type FeishuToolsConfig = {
  doc?: boolean;
  chat?: boolean;
  wiki?: boolean;
  drive?: boolean;
  perm?: boolean;
  scopes?: boolean;
  /** Bitable/Base operations (default: true). */
  bitable?: boolean;
  /** @deprecated Use bitable. */
  base?: boolean;
};

export type DynamicAgentCreationConfig = {
  enabled?: boolean;
  workspaceTemplate?: string;
  agentDirTemplate?: string;
  maxAgents?: number;
};
