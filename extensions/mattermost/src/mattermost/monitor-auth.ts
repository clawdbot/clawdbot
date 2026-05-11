import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/access-groups";
import {
  type ChannelIngressDecision,
  type ChannelIngressEventInput,
  type ChannelIngressIdentifierKind,
  resolveStableChannelMessageIngress,
  type StableChannelIngressIdentityParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostChannel } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { isDangerousNameMatchingEnabled, resolveAllowlistMatchSimple } from "./runtime-api.js";

const MATTERMOST_USER_NAME_KIND =
  "plugin:mattermost-user-name" as const satisfies ChannelIngressIdentifierKind;
const mattermostIngressIdentity = {
  key: "sender-id",
  normalize: normalizeMattermostAllowEntry,
  aliases: [
    {
      key: "sender-name",
      kind: MATTERMOST_USER_NAME_KIND,
      normalizeEntry: normalizeMattermostAllowEntry,
      normalizeSubject: normalizeMattermostAllowEntry,
      dangerous: true,
    },
  ],
  isWildcardEntry: (entry) => normalizeMattermostAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    `mattermost-entry-${entryIndex + 1}:${fieldKey === "sender-name" ? "name" : "user"}`,
} satisfies StableChannelIngressIdentityParams;

export function normalizeMattermostAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  const accessGroupName = parseAccessGroupAllowFromEntry(trimmed);
  if (accessGroupName) {
    return `accessGroup:${accessGroupName}`;
  }
  const normalized = trimmed
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim();
  return normalized ? normalizeLowercaseStringOrEmpty(normalized) : "";
}

export function normalizeMattermostAllowList(entries: Array<string | number>): string[] {
  const normalized = entries
    .map((entry) => normalizeMattermostAllowEntry(String(entry)))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

export function isMattermostSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
  allowNameMatching?: boolean;
}): boolean {
  const allowFrom = normalizeMattermostAllowList(params.allowFrom);
  if (allowFrom.length === 0) {
    return false;
  }
  const match = resolveAllowlistMatchSimple({
    allowFrom,
    senderId: normalizeMattermostAllowEntry(params.senderId),
    senderName: params.senderName ? normalizeMattermostAllowEntry(params.senderName) : undefined,
    allowNameMatching: params.allowNameMatching,
  });
  return match.allowed;
}

function mapMattermostChannelKind(channelType?: string | null): "direct" | "group" | "channel" {
  const normalized = channelType?.trim().toUpperCase();
  if (normalized === "D") {
    return "direct";
  }
  if (normalized === "G" || normalized === "P") {
    return "group";
  }
  return "channel";
}

export type MattermostCommandAuthDecision =
  | {
      ok: true;
      commandAuthorized: boolean;
      channelInfo: MattermostChannel;
      kind: "direct" | "group" | "channel";
      chatType: "direct" | "group" | "channel";
      channelName: string;
      channelDisplay: string;
      roomLabel: string;
    }
  | {
      ok: false;
      denyReason:
        | "unknown-channel"
        | "dm-disabled"
        | "dm-pairing"
        | "unauthorized"
        | "channels-disabled"
        | "channel-no-allowlist";
      commandAuthorized: false;
      channelInfo: MattermostChannel | null;
      kind: "direct" | "group" | "channel";
      chatType: "direct" | "group" | "channel";
      channelName: string;
      channelDisplay: string;
      roomLabel: string;
    };

type MattermostCommandDenyReason = Extract<
  MattermostCommandAuthDecision,
  { ok: false }
>["denyReason"];

export async function resolveMattermostMonitorInboundAccess(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  senderId: string;
  senderName: string;
  channelId: string;
  kind: "direct" | "group" | "channel";
  groupPolicy: "allowlist" | "open" | "disabled";
  storeAllowFrom?: Array<string | number> | null;
  readStoreAllowFrom?: () => Promise<Array<string | number>>;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  eventKind?: ChannelIngressEventInput["kind"];
  mayPair?: boolean;
}) {
  const {
    account,
    cfg,
    senderId,
    senderName,
    channelId,
    kind,
    groupPolicy,
    storeAllowFrom,
    allowTextCommands,
    hasControlCommand,
  } = params;
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const configAllowFrom = account.config.allowFrom ?? [];
  const configGroupAllowFrom = account.config.groupAllowFrom ?? [];
  const readStoreAllowFrom =
    params.readStoreAllowFrom ??
    (storeAllowFrom != null ? async () => [...storeAllowFrom] : undefined);
  const ingress = await resolveStableChannelMessageIngress({
    channelId: "mattermost",
    accountId: account.accountId,
    identity: mattermostIngressIdentity,
    cfg,
    ...(readStoreAllowFrom ? { readStoreAllowFrom } : {}),
    useDefaultPairingStore: params.readStoreAllowFrom === undefined && storeAllowFrom == null,
    subject: {
      stableId: senderId,
      aliases: { "sender-name": senderName },
    },
    conversation: {
      kind,
      id: channelId,
    },
    event: {
      kind: params.eventKind ?? "message",
      authMode: "inbound",
      mayPair: params.mayPair ?? true,
    },
    dmPolicy,
    groupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: true,
      mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
    },
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    command: {
      allowTextCommands,
      hasControlCommand: allowTextCommands && hasControlCommand,
      directGroupAllowFrom: kind === "direct" ? "effective" : "none",
    },
  });
  return ingress;
}

function resolveMattermostCommandDenyReason(params: {
  decision: ChannelIngressDecision;
  kind: "direct" | "group" | "channel";
  dmPolicy: string;
}): MattermostCommandDenyReason | null {
  if (params.decision.decision === "allow") {
    return null;
  }
  if (params.kind === "direct") {
    if (params.decision.reasonCode === "dm_policy_disabled") {
      return "dm-disabled";
    }
    if (
      params.dmPolicy === "pairing" &&
      (params.decision.admission === "pairing-required" ||
        params.decision.reasonCode === "dm_policy_pairing_required")
    ) {
      return "dm-pairing";
    }
    return "unauthorized";
  }
  if (params.decision.reasonCode === "group_policy_disabled") {
    return "channels-disabled";
  }
  if (params.decision.reasonCode === "group_policy_empty_allowlist") {
    return "channel-no-allowlist";
  }
  return "unauthorized";
}

export async function authorizeMattermostCommandInvocation(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  senderId: string;
  senderName: string;
  channelId: string;
  channelInfo: MattermostChannel | null;
  storeAllowFrom?: Array<string | number> | null;
  readStoreAllowFrom?: () => Promise<Array<string | number>>;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
}): Promise<MattermostCommandAuthDecision> {
  const {
    account,
    cfg,
    senderId,
    senderName,
    channelId,
    channelInfo,
    storeAllowFrom,
    readStoreAllowFrom,
    allowTextCommands,
    hasControlCommand,
  } = params;

  if (!channelInfo) {
    return {
      ok: false,
      denyReason: "unknown-channel",
      commandAuthorized: false,
      channelInfo: null,
      kind: "channel",
      chatType: "channel",
      channelName: "",
      channelDisplay: "",
      roomLabel: `#${channelId}`,
    };
  }

  const kind = mapMattermostChannelKind(channelInfo.type);
  const chatType = kind;
  const channelName = channelInfo.name ?? "";
  const channelDisplay = channelInfo.display_name ?? channelName;
  const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;

  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

  const ingress = await resolveMattermostMonitorInboundAccess({
    account,
    cfg,
    senderId,
    senderName,
    channelId,
    kind,
    groupPolicy,
    storeAllowFrom,
    readStoreAllowFrom,
    allowTextCommands,
    hasControlCommand,
    eventKind: "native-command",
    mayPair: true,
  });
  const denyReason = resolveMattermostCommandDenyReason({
    decision: ingress.ingress,
    kind,
    dmPolicy: account.config.dmPolicy ?? "pairing",
  });

  if (denyReason) {
    return {
      ok: false,
      denyReason,
      commandAuthorized: false,
      channelInfo,
      kind,
      chatType,
      channelName,
      channelDisplay,
      roomLabel,
    };
  }

  return {
    ok: true,
    commandAuthorized: ingress.commandAccess.authorized,
    channelInfo,
    kind,
    chatType,
    channelName,
    channelDisplay,
    roomLabel,
  };
}
