import { loadConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { isSelfChatMode, normalizeE164 } from "../../utils.js";
import { resolveWhatsAppAccount } from "../accounts.js";

export type InboundAccessControlResult = {
  allowed: boolean;
  shouldMarkRead: boolean;
  isSelfChat: boolean;
  resolvedAccountId: string;
};

const PAIRING_REPLY_HISTORY_GRACE_MS = 30_000;

export async function checkInboundAccessControl(params: {
  accountId: string;
  from: string;
  selfE164: string | null;
  senderE164: string | null;
  group: boolean;
  pushName?: string;
  isFromMe: boolean;
  messageTimestampMs?: number;
  connectedAtMs?: number;
  pairingGraceMs?: number;
  sock: {
    sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
  };
  remoteJid: string;
}): Promise<InboundAccessControlResult> {
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({
    cfg,
    accountId: params.accountId,
  });
  const dmPolicy = cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
  const configuredAllowFrom = account.allowFrom;
  const storeAllowFrom = await readChannelAllowFromStore("whatsapp").catch(() => []);
  // Without user config, default to self-only DM access so the owner can talk to themselves.
  const combinedAllowFrom = Array.from(
    new Set([...(configuredAllowFrom ?? []), ...storeAllowFrom]),
  );
  const defaultAllowFrom =
    combinedAllowFrom.length === 0 && params.selfE164 ? [params.selfE164] : undefined;
  const allowFrom = combinedAllowFrom.length > 0 ? combinedAllowFrom : defaultAllowFrom;
  const groupAllowFrom =
    account.groupAllowFrom ??
    (configuredAllowFrom && configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);
  const isSamePhone = params.from === params.selfE164;
  const isSelfChat = isSelfChatMode(params.selfE164, configuredAllowFrom);
  const pairingGraceMs =
    typeof params.pairingGraceMs === "number" && params.pairingGraceMs > 0
      ? params.pairingGraceMs
      : PAIRING_REPLY_HISTORY_GRACE_MS;
  const suppressPairingReply =
    typeof params.connectedAtMs === "number" &&
    typeof params.messageTimestampMs === "number" &&
    params.messageTimestampMs < params.connectedAtMs - pairingGraceMs;

  // Pre-compute normalized allowlists for filtering.
  const dmHasWildcard = allowFrom?.includes("*") ?? false;
  const normalizedAllowFrom =
    allowFrom && allowFrom.length > 0
      ? allowFrom.filter((entry) => entry !== "*").map(normalizeE164)
      : [];
  const groupHasWildcard = groupAllowFrom?.includes("*") ?? false;
  const normalizedGroupAllowFrom =
    groupAllowFrom && groupAllowFrom.length > 0
      ? groupAllowFrom.filter((entry) => entry !== "*").map(normalizeE164)
      : [];

  // Group policy filtering:
  // - "open": groups bypass allowFrom, only mention-gating applies
  // - "disabled": block all group messages entirely
  // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.groupPolicy ?? defaultGroupPolicy ?? "open";
  if (params.group && groupPolicy === "disabled") {
    logVerbose("Blocked group message (groupPolicy: disabled)");
    return {
      allowed: false,
      shouldMarkRead: false,
      isSelfChat,
      resolvedAccountId: account.accountId,
    };
  }
  if (params.group && groupPolicy === "allowlist") {
    if (!groupAllowFrom || groupAllowFrom.length === 0) {
      logVerbose("Blocked group message (groupPolicy: allowlist, no groupAllowFrom)");
      return {
        allowed: false,
        shouldMarkRead: false,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
    const senderAllowed =
      groupHasWildcard ||
      (params.senderE164 != null && normalizedGroupAllowFrom.includes(params.senderE164));
    if (!senderAllowed) {
      logVerbose(
        `Blocked group message from ${params.senderE164 ?? "unknown sender"} (groupPolicy: allowlist)`,
      );
      return {
        allowed: false,
        shouldMarkRead: false,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
  }

  // DM access control (secure defaults): "pairing" (default) / "allowlist" / "open" / "disabled".
  if (!params.group) {
    if (params.isFromMe && !isSamePhone) {
      logVerbose("Skipping outbound DM (fromMe); no pairing reply needed.");
      return {
        allowed: false,
        shouldMarkRead: false,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
    if (dmPolicy === "disabled") {
      logVerbose("Blocked dm (dmPolicy: disabled)");
      return {
        allowed: false,
        shouldMarkRead: false,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
    if (dmPolicy !== "open" && !isSamePhone) {
      const candidate = params.from;
      const allowed =
        dmHasWildcard ||
        (normalizedAllowFrom.length > 0 && normalizedAllowFrom.includes(candidate));
      if (!allowed) {
        if (dmPolicy === "pairing") {
          if (suppressPairingReply) {
            logVerbose(`Skipping pairing reply for historical DM from ${candidate}.`);
          } else {
            const { code, created } = await upsertChannelPairingRequest({
              channel: "whatsapp",
              id: candidate,
              meta: { name: (params.pushName ?? "").trim() || undefined },
            });
            if (created) {
              logVerbose(
                `whatsapp pairing request sender=${candidate} name=${params.pushName ?? "unknown"}`,
              );
              try {
                await params.sock.sendMessage(params.remoteJid, {
                  text: buildPairingReply({
                    channel: "whatsapp",
                    idLine: `Your WhatsApp phone number: ${candidate}`,
                    code,
                  }),
                });
              } catch (err) {
                logVerbose(`whatsapp pairing reply failed for ${candidate}: ${String(err)}`);
              }
            }
          }
        } else {
          logVerbose(`Blocked unauthorized sender ${candidate} (dmPolicy=${dmPolicy})`);
        }
        return {
          allowed: false,
          shouldMarkRead: false,
          isSelfChat,
          resolvedAccountId: account.accountId,
        };
      }
    }
  }

  return {
    allowed: true,
    shouldMarkRead: true,
    isSelfChat,
    resolvedAccountId: account.accountId,
  };
}
