// Telegram plugin module owns supersede sender authorization policy.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTelegramDmAllow } from "./access-groups.js";
import { mergeTelegramAccountConfig } from "./account-config.js";
import {
  resolveTelegramCommandAuthorization,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramMessageThreadSpec,
} from "./bot/helpers.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";

type UpdateSenderFacts = {
  senderId: string;
  senderUsername?: string;
  chatId: number;
  isGroup: boolean;
  message: Message;
};

function extractUpdateSenderFacts(update: unknown): UpdateSenderFacts | null {
  if (!update || typeof update !== "object") {
    return null;
  }
  const root = update as Record<string, unknown>;
  let message: Record<string, unknown> | undefined;
  for (const key of ["message", "edited_message", "channel_post", "edited_channel_post"] as const) {
    const candidate = root[key];
    if (candidate && typeof candidate === "object") {
      message = candidate as Record<string, unknown>;
      break;
    }
  }
  if (!message) {
    const callback = root.callback_query;
    if (callback && typeof callback === "object") {
      const cb = callback as Record<string, unknown>;
      const from = cb.from;
      const msg = cb.message;
      if (from && typeof from === "object" && msg && typeof msg === "object") {
        const chat = (msg as { chat?: { id?: unknown; type?: unknown; is_forum?: unknown } }).chat;
        const fromObj = from as { id?: unknown; username?: unknown };
        if (typeof chat?.id === "number" && typeof fromObj.id === "number") {
          const chatType = typeof chat.type === "string" ? chat.type : "private";
          return {
            senderId: String(fromObj.id),
            ...(typeof fromObj.username === "string" ? { senderUsername: fromObj.username } : {}),
            chatId: chat.id,
            isGroup: chatType !== "private",
            message: msg as Message,
          };
        }
      }
    }
    return null;
  }
  const chat = message.chat as { id?: unknown; type?: unknown; is_forum?: unknown } | undefined;
  const from = message.from as { id?: unknown; username?: unknown } | undefined;
  if (typeof chat?.id !== "number" || typeof from?.id !== "number") {
    return null;
  }
  const chatType = typeof chat.type === "string" ? chat.type : "private";
  return {
    senderId: String(from.id),
    ...(typeof from.username === "string" ? { senderUsername: from.username } : {}),
    chatId: chat.id,
    isGroup: chatType !== "private",
    message: message as unknown as Message,
  };
}

/** Ambient room_event-shaped updates (no user text body) stay supersedable. */
export function isTelegramAmbientSpooledUpdate(update: unknown): boolean {
  if (!update || typeof update !== "object") {
    return false;
  }
  const root = update as Record<string, unknown>;
  return (
    root.message_reaction != null ||
    root.message_reaction_count != null ||
    root.chat_member != null ||
    root.my_chat_member != null ||
    root.chat_join_request != null ||
    root.chat_boost != null ||
    root.removed_chat_boost != null
  );
}

export type TelegramSupersedeAuthContext = {
  cfg: OpenClawConfig;
  accountId: string;
  /** Bot username for @bot command targeting (from getMe / botInfo). */
  botUsername?: string;
  /** Test seam / preloaded pairing-store ids; defaults to live pairing store. */
};

/**
 * Whether the raw update's sender is command-authorized.
 * Reuses resolveTelegramGroupAllowFromContext — same group/topic allowFrom
 * overrides and access-group expansion as normal message ingress.
 */
export async function isTelegramSpooledUpdateSenderAuthorized(
  update: unknown,
  auth: TelegramSupersedeAuthContext,
): Promise<boolean> {
  const facts = extractUpdateSenderFacts(update);
  if (!facts) {
    return false;
  }
  const accountCfg = mergeTelegramAccountConfig(auth.cfg, auth.accountId);
  const dmPolicy = accountCfg.dmPolicy ?? "pairing";
  const allowFrom = accountCfg.allowFrom;
  const groupAllowFrom = accountCfg.groupAllowFrom ?? accountCfg.allowFrom;
  const threadSpec = resolveTelegramMessageThreadSpec(facts.message);
  const groupAllowContext = await resolveTelegramGroupAllowFromContext({
    cfg: auth.cfg,
    chatId: facts.chatId,
    accountId: auth.accountId,
    dmPolicy,
    allowFrom,
    senderId: facts.senderId,
    isGroup: facts.isGroup,
    threadSpec,
    groupAllowFrom,
    resolveTelegramGroupConfig: (chatId, messageThreadId, cfg) => {
      const telegramCfg = mergeTelegramAccountConfig(cfg, auth.accountId);
      return resolveTelegramScopedGroupConfig(telegramCfg, chatId, messageThreadId);
    },
  });

  const { resolvedThreadId, storeAllowFrom, groupAllowOverride, effectiveGroupAllow } =
    groupAllowContext;

  const dmAllow = await resolveTelegramDmAllow({
    cfg: auth.cfg,
    groupAllowOverride,
    allowFrom,
    accountId: auth.accountId,
    senderId: facts.senderId,
    storeAllowFrom: facts.isGroup ? [] : storeAllowFrom,
    dmPolicy,
  });

  const ownerAccess = resolveTelegramCommandAuthorization({
    cfg: auth.cfg,
    accountId: auth.accountId,
    chatId: facts.chatId,
    isGroup: facts.isGroup,
    threadSpec,
    senderId: facts.senderId,
    ...(facts.senderUsername !== undefined ? { senderUsername: facts.senderUsername } : {}),
  });
  const gate = await resolveTelegramCommandIngressAuthorization({
    accountId: auth.accountId,
    cfg: auth.cfg,
    dmPolicy,
    isGroup: facts.isGroup,
    chatId: facts.chatId,
    ...(resolvedThreadId !== undefined ? { resolvedThreadId } : {}),
    senderId: facts.senderId,
    effectiveDmAllow: dmAllow.effectiveAllow,
    effectiveGroupAllow,
    ownerAccess,
    eventKind: "message",
    allowTextCommands: true,
    hasControlCommand: true,
    modeWhenAccessGroupsOff: "allow",
    includeDmAllowForGroupCommands: false,
  });
  return gate.authorized;
}
