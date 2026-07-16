import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelGroupsScopeTree,
  resolveChannelGroupRequireMention,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  scopeKey,
  type GroupToolPolicyConfig,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
// Telegram plugin module implements group policy behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";

function parseTelegramGroupId(value?: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return { chatId: undefined, topicId: undefined };
  }
  const parts = raw.split(":").filter(Boolean);
  const chatId = parts[0];
  const second = parts[1];
  const third = parts[2];
  if (
    parts.length >= 3 &&
    second === "topic" &&
    chatId !== undefined &&
    /^-?\d+$/.test(chatId) &&
    third !== undefined &&
    /^\d+$/.test(third)
  ) {
    return {
      chatId: expectDefined(chatId, "validated Telegram group chat id"),
      topicId: expectDefined(third, "validated Telegram topic id"),
    };
  }
  if (
    parts.length >= 2 &&
    chatId !== undefined &&
    /^-?\d+$/.test(chatId) &&
    second !== undefined &&
    /^\d+$/.test(second)
  ) {
    return {
      chatId: expectDefined(chatId, "validated Telegram group chat id"),
      topicId: expectDefined(second, "validated Telegram topic id"),
    };
  }
  return { chatId: raw, topicId: undefined };
}

const groupScopeKey = (groupKey: string) => scopeKey(["group", groupKey]);
const topicScopeKey = (groupKey: string, topicKey: string) =>
  scopeKey(["group", groupKey], ["topic", topicKey]);

function resolveTelegramRequireMention(params: {
  cfg: ChannelGroupContext["cfg"];
  chatId?: string;
  topicId?: string;
  accountId?: string | null;
}): boolean | undefined {
  const { cfg, chatId, topicId, accountId } = params;
  if (!chatId) {
    return undefined;
  }
  const groups =
    (accountId ? cfg.channels?.telegram?.accounts?.[accountId]?.groups : undefined) ??
    cfg.channels?.telegram?.groups;
  const scopes: ScopeTree["scopes"] = {};
  const path: string[] = [];
  const add = (key: string, entry: { requireMention?: boolean } | undefined) => {
    if (entry) {
      scopes[key] = { requireMention: entry.requireMention };
      path.push(key);
    }
  };
  const groupConfig = groups?.[chatId];
  const groupDefault = groups?.["*"];
  add(groupScopeKey("*"), groupDefault);
  add(groupScopeKey(chatId), groupConfig);
  if (topicId) {
    // Resolver walks backward: group/topic → group/* → */topic → */* → group → *.
    // Adjacent topic nodes preserve wildcard/exact field merging within each group.
    add(topicScopeKey("*", "*"), groupDefault?.topics?.["*"]);
    add(topicScopeKey("*", topicId), groupDefault?.topics?.[topicId]);
    add(topicScopeKey(chatId, "*"), groupConfig?.topics?.["*"]);
    add(topicScopeKey(chatId, topicId), groupConfig?.topics?.[topicId]);
  }
  const hasConfiguredMention = path.some((key) => typeof scopes[key]?.requireMention === "boolean");
  return hasConfiguredMention ? resolveScopeRequireMention({ tree: { scopes }, path }) : undefined;
}

export function resolveTelegramGroupRequireMention(
  params: ChannelGroupContext,
): boolean | undefined {
  const { chatId, topicId } = parseTelegramGroupId(params.groupId);
  const requireMention = resolveTelegramRequireMention({
    cfg: params.cfg,
    chatId,
    topicId,
    accountId: params.accountId,
  });
  if (typeof requireMention === "boolean") {
    return requireMention;
  }
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "telegram",
    groupId: chatId ?? params.groupId,
    accountId: params.accountId,
  });
}

export function resolveTelegramGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const { chatId } = parseTelegramGroupId(params.groupId);
  const groupId = chatId ?? params.groupId?.trim();
  return resolveScopeToolsPolicy({
    tree: buildChannelGroupsScopeTree(params.cfg, "telegram", params.accountId),
    path: groupId ? [groupId] : [],
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    messageProvider: "telegram",
  });
}
