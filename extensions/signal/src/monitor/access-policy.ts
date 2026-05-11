import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import {
  formatSignalSenderId,
  looksLikeUuid,
  normalizeSignalAllowRecipient,
  type SignalSender,
} from "../identity.js";

type SignalDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type SignalGroupPolicy = "open" | "allowlist" | "disabled";

const SIGNAL_UUID_KIND = "plugin:signal-uuid" as const;
const SIGNAL_GROUP_KIND = "plugin:signal-group" as const;

function strippedSignalEntry(
  entry: string,
): { trimmed: string; signalStripped: string; lower: string } | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  const signalStripped = trimmed.replace(/^signal:/i, "").trim();
  const lower = signalStripped.toLowerCase();
  return { trimmed, signalStripped, lower };
}

function normalizeSignalGroupEntry(entry: string): string | null {
  const parsed = strippedSignalEntry(entry);
  if (!parsed) {
    return null;
  }
  const { trimmed, signalStripped, lower } = parsed;
  if (lower.startsWith("group:")) {
    const groupId = signalStripped.slice("group:".length).trim();
    return groupId || null;
  }
  return trimmed;
}

function normalizeSignalUuidEntry(entry: string): string | null {
  const parsed = strippedSignalEntry(entry);
  if (!parsed) {
    return null;
  }
  const { signalStripped, lower } = parsed;
  if (lower.startsWith("uuid:")) {
    const raw = signalStripped.slice("uuid:".length).trim();
    return raw || null;
  }
  return looksLikeUuid(signalStripped) ? signalStripped : null;
}

function normalizeSignalPhoneEntry(entry: string): string | null {
  const parsed = strippedSignalEntry(entry);
  if (!parsed) {
    return null;
  }
  return normalizeSignalAllowRecipient(parsed.trimmed) ?? null;
}

const signalIngressIdentity = defineStableChannelIngressIdentity({
  key: "stable",
  normalizeEntry: () => null,
  aliases: [
    {
      key: "phone",
      kind: "phone",
      normalizeEntry: normalizeSignalPhoneEntry,
      normalizeSubject: (value: string) => value,
      sensitivity: "pii",
    },
    {
      key: "uuid",
      kind: SIGNAL_UUID_KIND,
      normalizeEntry: normalizeSignalUuidEntry,
      normalizeSubject: (value: string) => value,
      sensitivity: "pii",
    },
    {
      key: "group",
      kind: SIGNAL_GROUP_KIND,
      normalizeEntry: normalizeSignalGroupEntry,
      normalizeSubject: (value: string) => value,
    },
  ],
  isWildcardEntry: (entry) => entry.trim() === "*",
  resolveEntryId({ entryIndex, fieldKey }) {
    return `entry-${entryIndex + 1}:${fieldKey}`;
  },
});

function signalSubjectInput(params: { sender: SignalSender; groupId?: string }) {
  return {
    stableId: formatSignalSenderId(params.sender),
    aliases: {
      phone: params.sender.kind === "phone" ? params.sender.e164 : undefined,
      uuid: params.sender.kind === "uuid" ? params.sender.raw : undefined,
      group: params.groupId,
    },
  };
}

export async function resolveSignalAccessState(params: {
  accountId: string;
  dmPolicy: SignalDmPolicy;
  groupPolicy: SignalGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  sender: SignalSender;
  groupId?: string;
  isGroup?: boolean;
  cfg?: Pick<OpenClawConfig, "accessGroups" | "commands">;
  hasControlCommand?: boolean;
  readStoreAllowFrom?: () => Promise<string[]>;
}) {
  const isGroup = params.isGroup ?? params.groupId != null;
  const command =
    params.hasControlCommand === true
      ? {
          allowTextCommands: true,
          directGroupAllowFrom: "effective" as const,
        }
      : undefined;
  const ingress = createChannelIngressResolver({
    channelId: "signal",
    accountId: params.accountId,
    identity: signalIngressIdentity,
    cfg: params.cfg,
    ...(params.readStoreAllowFrom ? { readStoreAllowFrom: params.readStoreAllowFrom } : {}),
    useDefaultPairingStore: params.readStoreAllowFrom == null,
  });
  return await ingress.message({
    subject: signalSubjectInput({
      sender: params.sender,
      groupId: isGroup ? params.groupId : undefined,
    }),
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? (params.groupId ?? "unknown") : params.sender.raw,
    },
    ...(isGroup ? { event: { mayPair: false } } : {}),
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
    policy: { groupAllowFromFallbackToAllowFrom: true },
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    command,
  });
}

export async function handleSignalDirectMessageAccess(params: {
  dmPolicy: SignalDmPolicy;
  dmAccessDecision: "allow" | "block" | "pairing";
  senderId: string;
  senderIdLine: string;
  senderDisplay: string;
  senderName?: string;
  accountId: string;
  sendPairingReply: (text: string) => Promise<void>;
  log: (message: string) => void;
}): Promise<boolean> {
  if (params.dmAccessDecision === "allow") {
    return true;
  }
  if (params.dmAccessDecision === "block") {
    if (params.dmPolicy !== "disabled") {
      params.log(`Blocked signal sender ${params.senderDisplay} (dmPolicy=${params.dmPolicy})`);
    }
    return false;
  }
  if (params.dmPolicy === "pairing") {
    await createChannelPairingChallengeIssuer({
      channel: "signal",
      upsertPairingRequest: async ({ id, meta }) =>
        await upsertChannelPairingRequest({
          channel: "signal",
          id,
          accountId: params.accountId,
          meta,
        }),
    })({
      senderId: params.senderId,
      senderIdLine: params.senderIdLine,
      meta: { name: params.senderName },
      sendPairingReply: params.sendPairingReply,
      onCreated: () => {
        params.log(`signal pairing request sender=${params.senderId}`);
      },
      onReplyError: (err) => {
        params.log(`signal pairing reply failed for ${params.senderId}: ${String(err)}`);
      },
    });
  }
  return false;
}
