// Telegram conversation routing and session-state lookup for bot handlers.
import { resolveStoredModelOverride } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import {
  getSessionEntry,
  listSessionEntries,
  readAmbientTranscriptWatermark,
  resolveAmbientTranscriptWatermarkKey,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveDefaultModelForAgent } from "./bot-handlers.agent.runtime.js";
import type { TelegramAmbientTranscriptWatermark } from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { resolveTelegramForumThreadId, shouldUseTelegramDmThreadSession } from "./bot/helpers.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";

export function createTelegramMessageSessionRuntime({
  accountId,
  resolveTelegramGroupConfig,
  telegramDeps,
}: Pick<
  RegisterTelegramHandlerParams,
  "accountId" | "resolveTelegramGroupConfig" | "telegramDeps"
>) {
  const resolveTelegramSessionState = (params: {
    chatId: number | string;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    resolvedThreadId?: number;
    botHasTopicsEnabled?: boolean;
    senderId?: string | number;
    runtimeCfg: OpenClawConfig;
  }) => {
    const resolvedThreadId =
      params.resolvedThreadId ??
      resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
    const topicThreadId = resolvedThreadId ?? dmThreadId;
    const { topicConfig } = resolveTelegramGroupConfig(
      params.chatId,
      topicThreadId,
      params.runtimeCfg,
    );
    const { route } = resolveTelegramConversationRoute({
      cfg: params.runtimeCfg,
      accountId,
      chatId: params.chatId,
      isGroup: params.isGroup,
      resolvedThreadId,
      replyThreadId: topicThreadId,
      senderId: params.senderId,
      topicAgentId: topicConfig?.agentId,
    });
    const baseSessionKey = resolveTelegramConversationBaseSessionKey({
      cfg: params.runtimeCfg,
      route,
      chatId: params.chatId,
      isGroup: params.isGroup,
      senderId: params.senderId,
    });
    const threadKeys =
      shouldUseTelegramDmThreadSession({
        dmThreadId,
        botHasTopicsEnabled: params.botHasTopicsEnabled,
      }) && dmThreadId != null
        ? resolveThreadSessionKeys({
            baseSessionKey,
            threadId: `${params.chatId}:${dmThreadId}`,
          })
        : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = telegramDeps.resolveStorePath(params.runtimeCfg.session?.store, {
      agentId: route.agentId,
    });
    const entry = (telegramDeps.getSessionEntry ?? getSessionEntry)({ storePath, sessionKey });
    const store = Object.fromEntries(
      (telegramDeps.listSessionEntries ?? listSessionEntries)({ storePath }).map(
        ({ sessionKey: key, entry: value }) => [key, value],
      ),
    );
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey,
      defaultProvider: resolveDefaultModelForAgent({
        cfg: params.runtimeCfg,
        agentId: route.agentId,
      }).provider,
    });
    if (storedOverride) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        storePath,
        model: storedOverride.provider
          ? `${storedOverride.provider}/${storedOverride.model}`
          : storedOverride.model,
      };
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        storePath,
        model: `${provider}/${model}`,
      };
    }
    const modelCfg = params.runtimeCfg.agents?.defaults?.model;
    return {
      agentId: route.agentId,
      sessionEntry: entry,
      sessionKey,
      storePath,
      model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary,
    };
  };

  const resolvePromptContextAmbientWatermark = (params: {
    chatId: number | string;
    isGroup: boolean;
    resolvedThreadId?: number;
    sessionKey: string;
    storePath: string;
  }): TelegramAmbientTranscriptWatermark | undefined => {
    if (!params.isGroup) {
      return undefined;
    }
    const key = (
      telegramDeps.resolveAmbientTranscriptWatermarkKey ?? resolveAmbientTranscriptWatermarkKey
    )({
      channel: "telegram",
      accountId,
      conversationId: String(params.chatId),
      ...(params.resolvedThreadId !== undefined ? { threadId: params.resolvedThreadId } : {}),
    });
    return (telegramDeps.readAmbientTranscriptWatermark ?? readAmbientTranscriptWatermark)({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      key,
    });
  };

  return { resolveTelegramSessionState, resolvePromptContextAmbientWatermark };
}

export type TelegramMessageSessionRuntime = ReturnType<typeof createTelegramMessageSessionRuntime>;
