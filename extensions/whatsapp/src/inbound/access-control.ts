// Whatsapp plugin module implements access control behavior.
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { warnMissingProviderGroupPolicyFallbackOnce } from "openclaw/plugin-sdk/runtime-group-policy";
import { resolveWhatsAppInboundPolicy, resolveWhatsAppIngressAccess } from "../inbound-policy.js";
import { buildWhatsAppInboundAdmission, type WhatsAppInboundAdmission } from "./admission.js";

type BlockedInboundAccessControlResult = {
  allowed: false;
  shouldMarkRead: false;
  isSelfChat: boolean;
  resolvedAccountId: string;
  admission?: never;
};

export type AcceptedInboundAccessControlResult = {
  allowed: true;
  shouldMarkRead: true;
  isSelfChat: boolean;
  resolvedAccountId: string;
  admission: WhatsAppInboundAdmission;
};

type InboundAccessControlResult =
  | BlockedInboundAccessControlResult
  | AcceptedInboundAccessControlResult;

const PAIRING_REPLY_HISTORY_GRACE_MS = 30_000;

function logWhatsAppVerbose(enabled: boolean | undefined, message: string) {
  if (!enabled) {
    return;
  }
  defaultRuntime.log(message);
}

function blockedInboundAccess(
  policy: ReturnType<typeof resolveWhatsAppInboundPolicy>,
): BlockedInboundAccessControlResult {
  return {
    allowed: false,
    shouldMarkRead: false,
    isSelfChat: policy.isSelfChat,
    resolvedAccountId: policy.account.accountId,
  };
}

export async function checkInboundAccessControl(params: {
  cfg: OpenClawConfig;
  accountId: string;
  from: string;
  selfE164: string | null;
  senderE164: string | null;
  senderJid?: string | null;
  group: boolean;
  pushName?: string;
  isFromMe: boolean;
  messageTimestampMs?: number;
  connectedAtMs?: number;
  pairingGraceMs?: number;
  verbose?: boolean;
  sock: {
    sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
  };
  remoteJid: string;
}): Promise<InboundAccessControlResult> {
  const policy = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
    selfE164: params.selfE164,
  });
  const pairingGraceMs =
    typeof params.pairingGraceMs === "number" && params.pairingGraceMs > 0
      ? params.pairingGraceMs
      : PAIRING_REPLY_HISTORY_GRACE_MS;
  const suppressPairingReply =
    typeof params.connectedAtMs === "number" &&
    typeof params.messageTimestampMs === "number" &&
    params.messageTimestampMs < params.connectedAtMs - pairingGraceMs;

  // Group policy filtering:
  // - "open": groups bypass allowFrom, only mention-gating applies
  // - "disabled": block all group messages entirely
  // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied: policy.providerMissingFallbackApplied,
    providerKey: "whatsapp",
    accountId: policy.account.accountId,
    log: (message) => logWhatsAppVerbose(params.verbose, message),
  });
  const conversationId = params.group ? params.remoteJid : params.from;
  const accessSenderId = params.group ? params.senderE164 : params.from;
  const admissionSenderId = params.group
    ? (params.senderE164 ?? params.senderJid ?? params.from)
    : params.from;
  const access = await resolveWhatsAppIngressAccess({
    cfg: params.cfg,
    policy,
    isGroup: params.group,
    conversationId,
    senderId: accessSenderId,
    dmSenderId: params.from,
  });
  const { senderAccess } = access;
  if (params.group && senderAccess.decision !== "allow") {
    if (senderAccess.reasonCode === "group_policy_disabled") {
      logWhatsAppVerbose(params.verbose, "Blocked group message (groupPolicy: disabled)");
    } else if (senderAccess.reasonCode === "group_policy_empty_allowlist") {
      logWhatsAppVerbose(
        params.verbose,
        "Blocked group message (groupPolicy: allowlist, no groupAllowFrom)",
      );
    } else {
      logWhatsAppVerbose(
        params.verbose,
        `Blocked group message from ${params.senderE164 ?? "unknown sender"} (groupPolicy: allowlist)`,
      );
    }
    return blockedInboundAccess(policy);
  }

  // DM access control (secure defaults): "pairing" (default) / "allowlist" / "open" / "disabled".
  if (!params.group) {
    if (params.isFromMe && !policy.isSamePhone(params.from)) {
      logWhatsAppVerbose(params.verbose, "Skipping outbound DM (fromMe); no pairing reply needed.");
      return blockedInboundAccess(policy);
    }
    if (senderAccess.decision === "block" && senderAccess.reasonCode === "dm_policy_disabled") {
      logWhatsAppVerbose(params.verbose, "Blocked dm (dmPolicy: disabled)");
      return blockedInboundAccess(policy);
    }
    if (senderAccess.decision === "pairing" && !policy.isSamePhone(params.from)) {
      const candidate = params.from;
      if (suppressPairingReply) {
        logWhatsAppVerbose(
          params.verbose,
          `Skipping pairing reply for historical DM from ${candidate}.`,
        );
      } else {
        await createChannelPairingChallengeIssuer({
          channel: "whatsapp",
          accountId: policy.account.accountId,
          upsertPairingRequest: async ({ id, meta }) =>
            await upsertChannelPairingRequest({
              channel: "whatsapp",
              id,
              accountId: policy.account.accountId,
              meta,
            }),
        })({
          senderId: candidate,
          senderIdLine: `Your WhatsApp phone number: ${candidate}`,
          meta: { name: (params.pushName ?? "").trim() || undefined },
          onCreated: () => {
            logWhatsAppVerbose(
              params.verbose,
              `whatsapp pairing request sender=${candidate} name=${params.pushName ?? "unknown"}`,
            );
          },
          sendPairingReply: async (text) => {
            await params.sock.sendMessage(params.remoteJid, { text });
          },
          onReplyError: (err) => {
            logWhatsAppVerbose(
              params.verbose,
              `whatsapp pairing reply failed for ${candidate}: ${String(err)}`,
            );
          },
        });
      }
      return blockedInboundAccess(policy);
    }
    if (senderAccess.decision !== "allow") {
      logWhatsAppVerbose(
        params.verbose,
        `Blocked unauthorized sender ${params.from} (dmPolicy=${policy.dmPolicy})`,
      );
      return blockedInboundAccess(policy);
    }
  }

  return {
    allowed: true,
    shouldMarkRead: true,
    isSelfChat: policy.isSelfChat,
    resolvedAccountId: policy.account.accountId,
    admission: buildWhatsAppInboundAdmission({
      policy,
      access,
      isGroup: params.group,
      conversationId,
      senderId: admissionSenderId,
    }),
  };
}

export const testing = {
  resolveWhatsAppInboundPolicy,
};
