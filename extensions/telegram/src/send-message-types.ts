import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import type { createTelegramPromptContextProjectionCursor } from "./prompt-context-projection.js";
import type { TelegramApi, TelegramApiOverride } from "./send-context.js";
import type { OpenClawConfig } from "./send.runtime.js";

export type TelegramSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  gatewayClientScopes?: readonly string[];
  maxBytes?: number;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  tableMode?: MarkdownTableMode;
  /** Send audio as voice message instead of audio file. Defaults to false. */
  asVoice?: boolean;
  /** Send video as video note instead of regular video. Defaults to false. */
  asVideoNote?: boolean;
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
  /** Shared cursor keeps one transcript projection contiguous across concrete sends. */
  promptContextProjectionPlan?: {
    cursor: ReturnType<typeof createTelegramPromptContextProjectionCursor>;
    finalPart: boolean;
  };
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Whether replyToMessageId came from ambient context or explicit payload/action input. */
  replyToIdSource?: "explicit" | "implicit";
  /** Controls whether replyToMessageId is applied to every internal text chunk. */
  replyToMode?: ReplyToMode;
  /** Quote text for Telegram reply_parameters. */
  quoteText?: string;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Inline keyboard buttons (reply markup). */
  buttons?: TelegramInlineButtons;
  /** Send image as document to avoid Telegram compression. Defaults to false. */
  forceDocument?: boolean;
  /** Persist each concrete platform send before any later chunk can fail. */
  onDeliveryResult?: (result: TelegramSendResult) => Promise<void> | void;
};

export type TelegramSendMessageParams = Parameters<TelegramApi["sendMessage"]>[2];

export type TelegramSendResult = {
  messageId: string;
  chatId: string;
  receipt?: MessageReceipt;
  meta?: {
    telegramDeliveredText?: string;
    telegramHasInlineKeyboard?: boolean;
  };
};

export type TelegramLocationSendOpts = Pick<
  TelegramSendOpts,
  | "cfg"
  | "token"
  | "accountId"
  | "verbose"
  | "api"
  | "retry"
  | "gatewayClientScopes"
  | "replyToMessageId"
  | "messageThreadId"
  | "buttons"
  | "quoteText"
  | "promptContextProjectionPlan"
  | "silent"
  | "onDeliveryResult"
>;
