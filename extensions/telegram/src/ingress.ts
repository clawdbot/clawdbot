import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  type ChannelIngressEventInput,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { DmPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAllowFrom, type NormalizedAllowFrom } from "./bot-access.js";

const TELEGRAM_CHANNEL_ID = "telegram";

const telegramIngressIdentity = defineStableChannelIngressIdentity({
  key: "telegram-user-id",
  normalize: (value) => {
    const normalized = normalizeAllowFrom([value]);
    return normalized.entries[0] ?? (normalized.hasWildcard ? "*" : null);
  },
  sensitivity: "pii",
});

export function createTelegramIngressSubject(senderId: string) {
  return { stableId: senderId };
}

export function createTelegramIngressResolver(params: {
  accountId?: string;
  cfg?: Pick<OpenClawConfig, "accessGroups" | "commands">;
}) {
  return createChannelIngressResolver({
    channelId: TELEGRAM_CHANNEL_ID,
    accountId: params.accountId ?? "default",
    identity: telegramIngressIdentity,
    cfg: params.cfg,
  });
}

export function telegramAllowEntries(allow: NormalizedAllowFrom): string[] {
  return [...(allow.hasWildcard ? ["*"] : []), ...allow.entries];
}

type TelegramOwnerCommandAccess = { ownerList: string[]; senderIsOwner: boolean };

function telegramConversation(params: {
  isGroup: boolean;
  chatId: string | number;
  resolvedThreadId?: number;
}) {
  return {
    kind: params.isGroup ? ("group" as const) : ("direct" as const),
    id: String(params.chatId),
    ...(params.resolvedThreadId != null ? { threadId: String(params.resolvedThreadId) } : {}),
  };
}

export async function resolveTelegramCommandIngressAuthorization(params: {
  accountId: string;
  cfg: OpenClawConfig;
  dmPolicy: DmPolicy;
  isGroup: boolean;
  chatId: string | number;
  resolvedThreadId?: number;
  senderId: string;
  effectiveDmAllow: NormalizedAllowFrom;
  effectiveGroupAllow: NormalizedAllowFrom;
  ownerAccess: TelegramOwnerCommandAccess;
  eventKind?: ChannelIngressEventInput["kind"];
  allowTextCommands?: boolean;
  hasControlCommand?: boolean;
  modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  includeDmAllowForGroupCommands?: boolean;
}) {
  const commandOwner = [
    ...(params.isGroup && params.includeDmAllowForGroupCommands === false
      ? []
      : telegramAllowEntries(params.effectiveDmAllow)),
    ...(params.ownerAccess.senderIsOwner ? [params.senderId || "*"] : params.ownerAccess.ownerList),
  ];
  const result = await createTelegramIngressResolver({
    accountId: params.accountId,
    cfg: params.cfg,
  }).command({
    subject: createTelegramIngressSubject(params.senderId),
    conversation: telegramConversation(params),
    event: {
      kind: params.eventKind ?? "native-command",
    },
    dmPolicy: params.dmPolicy,
    groupPolicy: "allowlist",
    allowFrom: commandOwner,
    groupAllowFrom: params.isGroup ? telegramAllowEntries(params.effectiveGroupAllow) : [],
    command: {
      allowTextCommands: params.allowTextCommands ?? false,
      hasControlCommand: params.hasControlCommand ?? false,
      modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff ?? "configured",
    },
  });
  return result.commandAccess;
}

export async function resolveTelegramEventIngressAuthorization(params: {
  accountId: string;
  dmPolicy: DmPolicy;
  isGroup: boolean;
  chatId: number;
  resolvedThreadId?: number;
  senderId: string;
  effectiveDmAllow: NormalizedAllowFrom;
  effectiveGroupAllow: NormalizedAllowFrom;
  enforceGroupAuthorization: boolean;
  eventKind: Extract<ChannelIngressEventInput["kind"], "reaction" | "button">;
}) {
  const result = await createTelegramIngressResolver({ accountId: params.accountId }).event({
    subject: createTelegramIngressSubject(params.senderId),
    conversation: telegramConversation(params),
    event: {
      kind: params.eventKind,
      authMode: "inbound",
    },
    dmPolicy: params.dmPolicy,
    groupPolicy: params.enforceGroupAuthorization ? "allowlist" : "open",
    allowFrom: telegramAllowEntries(params.effectiveDmAllow),
    groupAllowFrom: params.enforceGroupAuthorization
      ? telegramAllowEntries(params.effectiveGroupAllow)
      : [],
  });
  return result.ingress;
}
