// Telegram plugin module defines message-dispatch contracts.
import type { Bot } from "grammy";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { SessionEntry } from "./bot-message-dispatch.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import type { TelegramStreamMode } from "./bot/types.js";

export type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  telegramDeps?: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token" | "mediaMaxMb">;
  retryDispatchErrors?: boolean;
  suppressFailureFallback?: boolean;
  /**
   * Canonical turn ownership lifecycle from the durable ingress drain
   * (or a test double). Pre-adoption abort + adopt/defer/abandon.
   */
  turnAdoptionLifecycle?: {
    admission?: "exclusive" | "cancel-only";
    onAdopted: () => void | Promise<void>;
    onDeferred?: () => void;
    onAbandoned?: () => void;
    abortSignal?: AbortSignal;
  };
};

export type TelegramDispatchResult =
  | { kind: "completed" }
  | { kind: "failed-retryable"; error: unknown };

export type TelegramReasoningLevel = "off" | "on" | "stream";
export type TelegramTranscriptMirrorPayload = { text?: string; mediaUrls?: string[] };
export type CurrentTurnTranscriptFinal = { messageId?: string; text: string };
export type TelegramScopedTranscriptSession = { sessionId: string; storePath: string };

export type FreshTelegramSessionEntryLoader = ((
  agentId: string,
  sessionKey: string,
) => {
  storePath: string;
  entry?: SessionEntry;
}) & {
  clear: () => void;
};

export type TelegramAnswerBlockDelivery = {
  payload: ReplyPayload;
  text: string;
  buttons: import("./button-types.js").TelegramInlineButtons | undefined;
};

export type TelegramDispatchTurnState = {
  queuedFinal: boolean;
  attemptedVisibleFinalDelivery?: boolean;
  suppressSilentReplyFallback: boolean;
  hadErrorReplyFailureOrSkip: boolean;
  dispatchError?: unknown;
};
