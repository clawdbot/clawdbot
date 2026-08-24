// Whatsapp plugin module implements access control behavior.
import { createHash } from "node:crypto";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { warnMissingProviderGroupPolicyFallbackOnce } from "openclaw/plugin-sdk/runtime-group-policy";
import { resolveWhatsAppInboundPolicy, resolveWhatsAppIngressAccess } from "../inbound-policy.js";
import { normalizeE164 } from "../text-runtime.js";
import { buildWhatsAppInboundAdmission, type WhatsAppInboundAdmission } from "./admission.js";

type BlockedInboundAccessControlResult = {
  allowed: false;
  shouldMarkRead: false;
  isSelfChat: boolean;
  resolvedAccountId: string;
  admission?: never;
  reason?: string;
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
  reason?: string,
): BlockedInboundAccessControlResult {
  return {
    allowed: false,
    shouldMarkRead: false,
    isSelfChat: policy.isSelfChat,
    resolvedAccountId: policy.account.accountId,
    reason,
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
  messageId?: string;
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
  const resolveChannelIngress = async (
    contextBinding?: import("openclaw/plugin-sdk/channel-ingress-runtime").ChannelIngressContextBinding,
  ) =>
    await resolveWhatsAppIngressAccess({
      cfg: params.cfg,
      policy,
      isGroup: params.group,
      conversationId,
      senderId: accessSenderId,
      contextBinding,
    });
  const access = await resolveChannelIngress();
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
    if (
      params.isFromMe &&
      (policy.account.selfChatMode === false || !policy.isSamePhone(params.from))
    ) {
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

    const e164 = normalizeE164(params.from) ?? params.from;
    const exactCfg = policy.account.direct?.[e164];
    const wildcardCfg = policy.account.direct?.["*"];
    let rate: number | undefined;
    let scope: string | undefined;

    if (exactCfg?.replyRate !== undefined) {
      rate = exactCfg.replyRate;
      scope = `exact match ${e164}`;
    } else if (wildcardCfg?.replyRate !== undefined) {
      rate = wildcardCfg.replyRate;
      scope = "wildcard direct";
    } else if (policy.account.replyRate !== undefined) {
      rate = policy.account.replyRate;
      scope = "account default";
    }

    if (rate !== undefined) {
      logWhatsAppVerbose(
        params.verbose,
        `[whatsapp access-control] Resolved replyRate ${rate} from ${scope}`,
      );
    }

    if (typeof rate === "number" && rate >= 0 && rate < 1) {
      const messageHash = createHash("md5")
        .update(params.messageId ?? "test-fixture-id")
        .digest("hex")
        .substring(0, 8);
      const randomValue = parseInt(messageHash, 16) / 0xffffffff;
      if (randomValue >= rate) {
        logWhatsAppVerbose(
          params.verbose,
          `[whatsapp rate-limit] Dropping message ${params.messageId}... MD5 hash modulo ${randomValue.toFixed(2)} >= ${rate}`,
        );
        logWhatsAppVerbose(
          params.verbose,
          `Ignored message from ${params.from} (${rate * 100}% probabilistic rule).`,
        );
        return blockedInboundAccess(policy, "reply_rate_suppressed");
      }
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
      channelIngress: access,
      resolveChannelIngress,
      isGroup: params.group,
      conversationId,
      senderId: admissionSenderId,
    }),
  };
}
