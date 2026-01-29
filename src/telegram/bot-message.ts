import type { Bot } from "grammy";
import { buildTelegramMessageContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { MoltbotConfig } from "../config/types.clawdbot.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.telegram.js";
import type { DmPolicy, ReplyToMode } from "../config/types.base.js";
import type { HistoryEntry } from "../auto-reply/reply/history.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";

export const createTelegramMessageProcessor = (deps: {
  bot: Bot;
  cfg: MoltbotConfig;
  account: { accountId: string };
  telegramCfg: TelegramAccountConfig;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  dmPolicy: DmPolicy;
  allowFrom?: (string | number)[];
  groupAllowFrom?: (string | number)[];
  ackReactionScope: "off" | "group-mentions" | "group-all" | "direct" | "all";
  logger: { info: (obj: Record<string, unknown>, msg: string) => void };
  resolveGroupActivation: (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
  }) => boolean | undefined;
  resolveGroupRequireMention: (chatId: string | number) => boolean;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => {
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
  };
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  opts: { token: string };
  resolveBotTopicsEnabled: (ctx?: TelegramContext) => Promise<boolean>;
}) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    resolveBotTopicsEnabled,
  } = deps;

  return async (
    primaryCtx: TelegramContext,
    allMedia: Array<{
      path: string;
      contentType?: string;
      stickerMetadata?: { emoji?: string; setName?: string; fileId?: string };
    }>,
    storeAllowFrom: string[],
    options?: { forceWasMentioned?: boolean; messageIdOverride?: string },
  ) => {
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
    });
    if (!context) return;
    await dispatchTelegramMessage({
      context,
      bot,
      cfg,
      runtime,
      replyToMode,
      streamMode,
      textLimit,
      telegramCfg,
      opts,
      resolveBotTopicsEnabled,
    });
  };
};
