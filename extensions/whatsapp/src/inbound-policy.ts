import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import type {
  ChannelGroupPolicy,
  DmPolicy,
  GroupPolicy,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-types";
import { resolveDefaultGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import {
  expandAllowFromWithAccessGroups,
  readStoreAllowFromForDmPolicy,
  resolveEffectiveAllowFromLists,
  resolveDmGroupAccessWithCommandGate,
} from "openclaw/plugin-sdk/security-runtime";
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
  shouldReadStorePairingApprovals: boolean;
  isSamePhone: (value?: string | null) => boolean;
  isDmSenderAllowed: (allowEntries: string[], sender?: string | null) => boolean;
  isGroupSenderAllowed: (allowEntries: string[], sender?: string | null) => boolean;
  resolveConversationGroupPolicy: (conversationId: string) => ChannelGroupPolicy;
  resolveConversationRequireMention: (conversationId: string) => boolean;
};

function resolveGroupConversationId(conversationId: string): string {
  return (
    resolveGroupSessionKey({
      From: conversationId,
      ChatType: "group",
      Provider: "whatsapp",
    })?.id ?? conversationId
  );
}

function isNormalizedSenderAllowed(allowEntries: string[], sender?: string | null): boolean {
  if (allowEntries.includes("*")) {
    return true;
  }
  const normalizedSender = normalizeE164(sender ?? "");
  if (!normalizedSender) {
    return false;
  }
  const normalizedEntrySet = new Set(
    allowEntries
      .map((entry) => normalizeE164(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
  return normalizedEntrySet.has(normalizedSender);
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
  const groupAllowFrom =
    account.groupAllowFrom ??
    (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined) ??
    [];
  const { effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: configuredAllowFrom,
    groupAllowFrom,
  });
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
    shouldReadStorePairingApprovals: dmPolicy !== "allowlist",
    isSamePhone,
    isDmSenderAllowed: (allowEntries, sender) =>
      isSamePhone(sender) || isNormalizedSenderAllowed(allowEntries, sender),
    isGroupSenderAllowed: (allowEntries, sender) => isNormalizedSenderAllowed(allowEntries, sender),
    resolveConversationGroupPolicy: (conversationId) =>
      resolveChannelGroupPolicy({
        cfg: resolvedGroupCfg,
        channel: "whatsapp",
        groupId: resolveGroupConversationId(conversationId),
        hasGroupAllowFrom: effectiveGroupAllowFrom.length > 0,
      }),
    resolveConversationRequireMention: (conversationId) =>
      resolveChannelGroupRequireMention({
        cfg: resolvedGroupCfg,
        channel: "whatsapp",
        groupId: resolveGroupConversationId(conversationId),
      }),
  };
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
  const normalizedSender = normalizeE164(isGroup ? groupSender : dmSender);
  if (!normalizedSender) {
    return false;
  }

  const storeAllowFrom =
    isGroup || !policy.shouldReadStorePairingApprovals
      ? []
      : await readStoreAllowFromForDmPolicy({
          provider: "whatsapp",
          accountId: policy.account.accountId,
          dmPolicy: policy.dmPolicy,
          shouldRead: policy.shouldReadStorePairingApprovals,
        });
  const isSenderAllowed = (senderId: string, allowEntries: string[]) =>
    isGroup
      ? policy.isGroupSenderAllowed(allowEntries, senderId)
      : policy.isDmSenderAllowed(allowEntries, senderId);
  const [allowFrom, groupAllowFrom] = await Promise.all([
    expandAllowFromWithAccessGroups({
      cfg: params.cfg,
      allowFrom: policy.dmAllowFrom,
      channel: "whatsapp",
      accountId: policy.account.accountId,
      senderId: normalizedSender,
      isSenderAllowed,
    }),
    expandAllowFromWithAccessGroups({
      cfg: params.cfg,
      allowFrom: policy.groupAllowFrom,
      channel: "whatsapp",
      accountId: policy.account.accountId,
      senderId: normalizedSender,
      isSenderAllowed,
    }),
  ]);
  const dmStoreAllowFrom = isGroup
    ? []
    : await expandAllowFromWithAccessGroups({
        cfg: params.cfg,
        allowFrom: storeAllowFrom,
        channel: "whatsapp",
        accountId: policy.account.accountId,
        senderId: normalizedSender,
        isSenderAllowed,
      });
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy: policy.dmPolicy,
    groupPolicy: policy.groupPolicy,
    allowFrom,
    groupAllowFrom,
    storeAllowFrom: dmStoreAllowFrom,
    isSenderAllowed: (allowEntries) =>
      isGroup
        ? policy.isGroupSenderAllowed(allowEntries, groupSender)
        : policy.isDmSenderAllowed(allowEntries, dmSender),
    command: {
      useAccessGroups,
      allowTextCommands: true,
      hasControlCommand: true,
    },
  });
  return access.commandAuthorized;
}
