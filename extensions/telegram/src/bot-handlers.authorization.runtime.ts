// Telegram sender authorization shared by message, reaction, and callback handlers.
import type { Message } from "grammy/types";
import type {
  DmPolicy,
  OpenClawConfig,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramAccount } from "./accounts.js";
import {
  normalizeDmAllowFromWithStore,
  resolveTelegramEffectiveDmPolicy,
  type NormalizedAllowFrom,
} from "./bot-access.js";
import { shouldSkipTelegramGroupMessage } from "./bot-handlers.authorization-groups.runtime.js";
import { resolveTelegramMessageTurnSettings } from "./bot-message.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  isTelegramCommandsAllowFromConfigured,
  resolveTelegramCommandAuthorization,
  resolveTelegramGroupAllowFromContext,
} from "./bot/helpers.js";
import { enforceTelegramDmAccess, isTelegramDmAccessAllowed } from "./dm-access.js";
import {
  resolveTelegramCommandIngressAuthorization,
  resolveTelegramEventIngressAuthorization,
} from "./ingress.js";

export type TelegramEventAuthorizationMode = "reaction" | "callback-scope" | "callback-allowlist";

export function createTelegramHandlerAuthorizationRuntime({
  accountId,
  bot,
  opts,
  logger,
  telegramDeps,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
}: RegisterTelegramHandlerParams) {
  const shouldSkipGroupMessage = (params: Parameters<typeof shouldSkipTelegramGroupMessage>[0]) =>
    shouldSkipTelegramGroupMessage(params, { logger, resolveGroupPolicy });

  type TelegramGroupAllowContext = Awaited<ReturnType<typeof resolveTelegramGroupAllowFromContext>>;
  type TelegramEventAuthorizationContextValue = TelegramGroupAllowContext & {
    cfg: OpenClawConfig;
    telegramCfg: TelegramAccountConfig;
    allowFrom: ReturnType<typeof resolveTelegramMessageTurnSettings>["allowFrom"];
    dmPolicy: DmPolicy;
  };
  const TELEGRAM_EVENT_AUTH_RULES: Record<
    TelegramEventAuthorizationMode,
    {
      enforceDirectAuthorization: boolean;
      enforceGroupAllowlistAuthorization: boolean;
      deniedDmReason: string;
      deniedGroupReason: string;
    }
  > = {
    reaction: {
      enforceDirectAuthorization: true,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "reaction unauthorized by dm policy/allowlist",
      deniedGroupReason: "reaction unauthorized by group allowlist",
    },
    "callback-scope": {
      enforceDirectAuthorization: false,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope",
    },
    "callback-allowlist": {
      enforceDirectAuthorization: true,
      // Group auth is already enforced by shouldSkipGroupMessage (group policy + allowlist).
      // An extra allowlist gate here would block users whose original command was authorized.
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope allowlist",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope allowlist",
    },
  };

  // Authorization owns one ingress snapshot. The agent turn intentionally
  // captures again after batching so reloads during debounce apply to execution.
  const resolveTelegramEventAuthorizationContext = async (params: {
    cfg: OpenClawConfig;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    senderId?: string;
    messageThreadId?: number;
  }): Promise<TelegramEventAuthorizationContextValue> => {
    const authorizationCfg = params.cfg;
    const authorizationTelegramCfg = resolveTelegramAccount({
      cfg: authorizationCfg,
      accountId,
    }).config;
    const authorizationSettings = resolveTelegramMessageTurnSettings({
      accountId,
      cfg: authorizationCfg,
      telegramCfg: authorizationTelegramCfg,
      opts,
    });
    const groupAllowContext = await resolveTelegramGroupAllowFromContext({
      cfg: authorizationCfg,
      chatId: params.chatId,
      accountId,
      dmPolicy: authorizationSettings.dmPolicy,
      allowFrom: authorizationSettings.allowFrom,
      senderId: params.senderId,
      isGroup: params.isGroup,
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
      groupAllowFrom: authorizationSettings.groupAllowFrom,
      readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
      resolveTelegramGroupConfig,
    });
    const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
      isGroup: params.isGroup,
      groupConfig: groupAllowContext.groupConfig,
      dmPolicy: authorizationSettings.dmPolicy,
    });
    return {
      cfg: authorizationCfg,
      allowFrom: authorizationSettings.allowFrom,
      telegramCfg: authorizationTelegramCfg,
      dmPolicy: effectiveDmPolicy,
      ...groupAllowContext,
    };
  };

  const authorizeTelegramEventSender = async (params: {
    chatId: number;
    chatTitle?: string;
    isGroup: boolean;
    senderId: string;
    senderUsername: string;
    mode: TelegramEventAuthorizationMode;
    context: TelegramEventAuthorizationContextValue;
  }): Promise<boolean> => {
    const { chatId, chatTitle, isGroup, senderId, senderUsername, mode, context } = params;
    const {
      dmPolicy,
      resolvedThreadId,
      storeAllowFrom,
      groupConfig,
      topicConfig,
      groupAllowOverride,
      effectiveGroupAllow,
      hasGroupAllowOverride,
      cfg: authorizationCfg,
      telegramCfg: authorizationTelegramCfg,
      allowFrom: authorizationAllowFrom,
    } = context;
    const authRules = TELEGRAM_EVENT_AUTH_RULES[mode];
    const {
      enforceDirectAuthorization,
      enforceGroupAllowlistAuthorization,
      deniedDmReason,
      deniedGroupReason,
    } = authRules;
    if (
      shouldSkipGroupMessage({
        isGroup,
        chatId,
        chatTitle,
        resolvedThreadId,
        senderId,
        senderUsername,
        effectiveGroupAllow,
        hasGroupAllowOverride,
        groupConfig,
        topicConfig,
        cfg: authorizationCfg,
        telegramCfg: authorizationTelegramCfg,
      })
    ) {
      return false;
    }

    if (!isGroup && enforceDirectAuthorization) {
      // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom.
      const dmAllowFrom = groupAllowOverride ?? authorizationAllowFrom;
      const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
        cfg: authorizationCfg,
        allowFrom: dmAllowFrom,
        accountId,
        senderId,
      });
      const effectiveDmAllow = normalizeDmAllowFromWithStore({
        allowFrom: expandedDmAllowFrom,
        storeAllowFrom,
        dmPolicy,
      });
      const eventAccess = await resolveTelegramEventIngressAuthorization({
        accountId,
        dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId,
        senderId,
        effectiveDmAllow,
        effectiveGroupAllow,
        enforceGroupAuthorization: false,
        eventKind: mode === "reaction" ? "reaction" : "button",
      });
      if (eventAccess.decision !== "allow") {
        if (eventAccess.reasonCode === "dm_policy_disabled") {
          logVerbose(
            `Blocked telegram direct event from ${senderId || "unknown"} (${deniedDmReason})`,
          );
          return false;
        }
        logVerbose(`Blocked telegram direct sender ${senderId || "unknown"} (${deniedDmReason})`);
        return false;
      }
    }
    if (isGroup && enforceGroupAllowlistAuthorization) {
      const eventAccess = await resolveTelegramEventIngressAuthorization({
        accountId,
        dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId,
        senderId,
        effectiveDmAllow: normalizeDmAllowFromWithStore({ allowFrom: [], dmPolicy }),
        effectiveGroupAllow,
        enforceGroupAuthorization: true,
        eventKind: mode === "reaction" ? "reaction" : "button",
      });
      if (eventAccess.decision !== "allow") {
        logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (${deniedGroupReason})`);
        return false;
      }
    }
    return true;
  };

  const isTelegramModelCallbackAuthorized = async (params: {
    chatId: number;
    isGroup: boolean;
    senderId: string;
    senderUsername: string;
    context: TelegramEventAuthorizationContextValue;
  }): Promise<boolean> => {
    const { chatId, isGroup, senderId, senderUsername, context } = params;
    const cfgLocal = context.cfg;
    const dmAllowFrom = context.groupAllowOverride ?? context.allowFrom;
    if (isTelegramCommandsAllowFromConfigured(cfgLocal)) {
      return resolveTelegramCommandAuthorization({
        cfg: cfgLocal,
        accountId,
        chatId,
        isGroup,
        resolvedThreadId: context.resolvedThreadId,
        senderId,
        senderUsername,
      }).isAuthorizedSender;
    }

    const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
      cfg: cfgLocal,
      allowFrom: dmAllowFrom,
      accountId,
      senderId,
    });
    const dmAllow = normalizeDmAllowFromWithStore({
      allowFrom: expandedDmAllowFrom,
      storeAllowFrom: isGroup ? [] : context.storeAllowFrom,
      dmPolicy: context.dmPolicy,
    });
    return (
      await resolveTelegramCommandIngressAuthorization({
        accountId,
        cfg: cfgLocal,
        dmPolicy: context.dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId: context.resolvedThreadId,
        senderId,
        effectiveDmAllow: dmAllow,
        effectiveGroupAllow: context.effectiveGroupAllow,
        ownerAccess: { ownerList: [], senderIsOwner: false },
        eventKind: "button",
      })
    ).authorized;
  };
  type TelegramInboundGate =
    | { allowed: false }
    | {
        allowed: true;
        context: TelegramEventAuthorizationContextValue;
        effectiveDmAllow: NormalizedAllowFrom;
      };

  // Single authorization gate for every message-like update that can reach the
  // reply-chain cache or dispatch: fresh messages, edits, channel posts. Must run
  // before any cache/dedupe side effect so blocked content is never recorded.
  // dmAccess "challenge" may send a pairing reply; "silent" only decides (edits
  // must never reply).
  const authorizeInboundMessage = async (params: {
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    senderId: string;
    senderUsername: string;
    requireConfiguredGroup: boolean;
    dmAccess: "challenge" | "silent";
  }): Promise<TelegramInboundGate> => {
    const authorizationCfg = telegramDeps.getRuntimeConfig();
    const context = await resolveTelegramEventAuthorizationContext({
      cfg: authorizationCfg,
      chatId: params.chatId,
      isGroup: params.isGroup,
      isForum: params.isForum,
      senderId: params.senderId,
      messageThreadId: params.messageThreadId,
    });
    const {
      dmPolicy,
      resolvedThreadId,
      dmThreadId,
      storeAllowFrom,
      groupConfig,
      topicConfig,
      groupAllowOverride,
      effectiveGroupAllow,
      hasGroupAllowOverride,
      telegramCfg: authorizationTelegramCfg,
      allowFrom: authorizationAllowFrom,
    } = context;
    // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
    const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
      cfg: authorizationCfg,
      allowFrom: groupAllowOverride ?? authorizationAllowFrom,
      accountId,
      senderId: params.senderId,
    });
    const effectiveDmAllow = normalizeDmAllowFromWithStore({
      allowFrom: expandedDmAllowFrom,
      storeAllowFrom,
      dmPolicy,
    });

    if (params.requireConfiguredGroup && (!groupConfig || groupConfig.enabled === false)) {
      logVerbose(`Blocked telegram channel ${params.chatId} (channel disabled)`);
      return { allowed: false };
    }

    if (
      shouldSkipGroupMessage({
        isGroup: params.isGroup,
        chatId: params.chatId,
        chatTitle: params.msg.chat.title,
        resolvedThreadId,
        senderId: params.senderId,
        senderUsername: params.senderUsername,
        effectiveGroupAllow,
        hasGroupAllowOverride,
        groupConfig,
        topicConfig,
        cfg: authorizationCfg,
        telegramCfg: authorizationTelegramCfg,
      })
    ) {
      return { allowed: false };
    }

    if (!params.isGroup) {
      const requireTopic =
        groupConfig && "requireTopic" in groupConfig ? groupConfig.requireTopic : undefined;
      if (requireTopic === true && dmThreadId == null) {
        logVerbose(`Blocked telegram DM ${params.chatId}: requireTopic=true but no topic present`);
        return { allowed: false };
      }
      const dmAuthorized =
        params.dmAccess === "challenge"
          ? await enforceTelegramDmAccess({
              isGroup: params.isGroup,
              dmPolicy,
              msg: params.msg,
              chatId: params.chatId,
              effectiveDmAllow,
              accountId,
              bot,
              logger,
              upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
            })
          : await isTelegramDmAccessAllowed({
              dmPolicy,
              msg: params.msg,
              chatId: params.chatId,
              effectiveDmAllow,
              accountId,
            });
      if (!dmAuthorized) {
        return { allowed: false };
      }
    }

    return { allowed: true, context, effectiveDmAllow };
  };

  return {
    resolveTelegramEventAuthorizationContext,
    authorizeTelegramEventSender,
    isTelegramModelCallbackAuthorized,
    authorizeInboundMessage,
  };
}

export type TelegramHandlerAuthorizationRuntime = ReturnType<
  typeof createTelegramHandlerAuthorizationRuntime
>;
