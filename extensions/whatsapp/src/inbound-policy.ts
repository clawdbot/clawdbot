import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import type {
  ChannelGroupPolicy,
  DmPolicy,
  GroupPolicy,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveDefaultGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { resolveGroupSessionKey } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveWhatsAppAccount, type ResolvedWhatsAppAccount } from "./accounts.js";
import { getSelfIdentity, getSenderIdentity } from "./identity.js";
import type { WebInboundMessage } from "./inbound/types.js";
import { resolveWhatsAppRuntimeGroupPolicy } from "./runtime-group-policy.js";
import { isSelfChatMode, normalizeE164 } from "./text-runtime.js";

export type ResolvedWhatsAppInboundPolicy = {
  account: ResolvedWhatsAppAccount;
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  configuredAllowFrom: string[];
  dmAllowFrom: string[];
  groupAllowFrom: string[];
  isSelfChat: boolean;
  providerMissingFallbackApplied: boolean;
  isSamePhone: (value?: string | null) => boolean;
  resolveConversationGroupPolicy: (conversationId: string) => ChannelGroupPolicy;
  resolveConversationRequireMention: (conversationId: string) => boolean;
};

function normalizeWhatsAppIngressPhone(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return normalizeE164(trimmed);
}

function resolveGroupConversationId(conversationId: string): string {
  return (
    resolveGroupSessionKey({
      From: conversationId,
      ChatType: "group",
      Provider: "whatsapp",
    })?.id ?? conversationId
  );
}

function maybeSamePhoneDmAllowFrom(params: {
  isGroup: boolean;
  policy: ResolvedWhatsAppInboundPolicy;
  dmSenderId?: string | null;
}): string[] {
  if (params.isGroup || !params.dmSenderId || !params.policy.isSamePhone(params.dmSenderId)) {
    return [];
  }
  return [params.dmSenderId];
}

function buildResolvedWhatsAppGroupConfig(params: {
  groupPolicy: GroupPolicy;
  groups: ResolvedWhatsAppAccount["groups"];
}): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        groupPolicy: params.groupPolicy,
        groups: params.groups,
      },
    },
  } as OpenClawConfig;
}

export function resolveWhatsAppInboundPolicy(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  selfE164?: string | null;
}): ResolvedWhatsAppInboundPolicy {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const configuredAllowFrom = account.allowFrom ?? [];
  const dmPolicy = account.dmPolicy ?? "pairing";
  const dmAllowFrom =
    configuredAllowFrom.length > 0 ? configuredAllowFrom : params.selfE164 ? [params.selfE164] : [];
  const configuredGroupAllowFrom =
    Array.isArray(account.groupAllowFrom) && account.groupAllowFrom.length > 0
      ? account.groupAllowFrom
      : undefined;
  const groupAllowFrom =
    configuredGroupAllowFrom ??
    (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined) ??
    [];
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const { groupPolicy, providerMissingFallbackApplied } = resolveWhatsAppRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.whatsapp !== undefined,
    groupPolicy: account.groupPolicy,
    defaultGroupPolicy,
  });
  const resolvedGroupCfg = buildResolvedWhatsAppGroupConfig({
    groupPolicy,
    groups: account.groups,
  });
  const isSamePhone = (value?: string | null) =>
    typeof value === "string" && typeof params.selfE164 === "string" && value === params.selfE164;
  return {
    account,
    dmPolicy,
    groupPolicy,
    configuredAllowFrom,
    dmAllowFrom,
    groupAllowFrom,
    isSelfChat: account.selfChatMode ?? isSelfChatMode(params.selfE164, configuredAllowFrom),
    providerMissingFallbackApplied,
    isSamePhone,
    resolveConversationGroupPolicy: (conversationId) =>
      resolveChannelGroupPolicy({
        cfg: resolvedGroupCfg,
        channel: "whatsapp",
        groupId: resolveGroupConversationId(conversationId),
        hasGroupAllowFrom: groupAllowFrom.length > 0,
      }),
    resolveConversationRequireMention: (conversationId) =>
      resolveChannelGroupRequireMention({
        cfg: resolvedGroupCfg,
        channel: "whatsapp",
        groupId: resolveGroupConversationId(conversationId),
      }),
  };
}

export async function resolveWhatsAppIngressAccess(params: {
  cfg: OpenClawConfig;
  policy: ResolvedWhatsAppInboundPolicy;
  isGroup: boolean;
  conversationId: string;
  senderId?: string | null;
  dmSenderId?: string | null;
  includeCommand?: boolean;
}) {
  const samePhoneDmAllowFrom = maybeSamePhoneDmAllowFrom({
    isGroup: params.isGroup,
    policy: params.policy,
    dmSenderId: params.dmSenderId,
  });
  const dmAllowFrom = [...params.policy.dmAllowFrom, ...samePhoneDmAllowFrom];
  return await resolveStableChannelMessageIngress({
    channelId: "whatsapp",
    accountId: params.policy.account.accountId,
    identity: {
      key: "whatsapp-sender-phone",
      kind: "phone",
      normalize: normalizeWhatsAppIngressPhone,
      sensitivity: "pii",
      entryIdPrefix: "whatsapp-entry",
    },
    cfg: params.cfg,
    useDefaultPairingStore: true,
    subject: { stableId: params.senderId ?? "" },
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
    },
    dmPolicy: params.policy.dmPolicy,
    groupPolicy: params.policy.groupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
    },
    allowFrom: dmAllowFrom,
    groupAllowFrom: params.policy.groupAllowFrom,
    command: params.includeCommand === true ? {} : undefined,
  });
}

export async function resolveWhatsAppCommandAuthorized(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  policy?: ResolvedWhatsAppInboundPolicy;
}): Promise<boolean> {
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  if (!useAccessGroups) {
    return true;
  }

  const self = getSelfIdentity(params.msg);
  const policy =
    params.policy ??
    resolveWhatsAppInboundPolicy({
      cfg: params.cfg,
      accountId: params.msg.accountId,
      selfE164: self.e164 ?? null,
    });
  const isGroup = params.msg.chatType === "group";
  const sender = getSenderIdentity(params.msg);
  const dmSender = sender.e164 ?? params.msg.from ?? "";
  const groupSender = sender.e164 ?? "";
  if (!normalizeE164(isGroup ? groupSender : dmSender)) {
    return false;
  }

  const access = await resolveWhatsAppIngressAccess({
    cfg: params.cfg,
    policy,
    isGroup,
    conversationId: params.msg.conversationId ?? params.msg.chatId ?? params.msg.from,
    senderId: isGroup ? groupSender : dmSender,
    dmSenderId: dmSender,
    includeCommand: true,
  });
  return access.commandAccess.authorized;
}
