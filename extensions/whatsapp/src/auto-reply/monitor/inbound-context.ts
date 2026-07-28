// Whatsapp plugin module implements inbound context behavior.
import {
  filterChannelInboundQuoteContext,
  formatMediaPlaceholderText,
  resolveInboundSupplementalSenderAllowed,
} from "openclaw/plugin-sdk/channel-inbound";
import type { HistoryMediaEntry } from "openclaw/plugin-sdk/reply-history";
import { filterSupplementalContextItems } from "openclaw/plugin-sdk/security-runtime";
import {
  getComparableIdentityValues,
  getReplyContext,
  resolveComparableIdentity,
  type WhatsAppIdentity,
  type WhatsAppReplyContext,
} from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { normalizeE164 } from "../../text-runtime.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
  media?: HistoryMediaEntry[];
};

type ContextVisibilityMode = "all" | "allowlist" | "allowlist_quote";

function isWhatsAppSupplementalSenderAllowed(params: {
  allowFrom: readonly string[];
  authDir?: string;
  sender?: WhatsAppIdentity | null;
}): boolean {
  if (params.allowFrom.includes("*")) {
    return true;
  }
  const senderValues = new Set(
    getComparableIdentityValues(resolveComparableIdentity(params.sender, params.authDir)),
  );
  if (senderValues.size === 0) {
    return false;
  }
  for (const entry of params.allowFrom) {
    const rawEntry = entry.trim();
    if (!rawEntry) {
      continue;
    }
    const normalizedEntry = normalizeE164(rawEntry);
    if ((normalizedEntry && senderValues.has(normalizedEntry)) || senderValues.has(rawEntry)) {
      return true;
    }
  }
  return false;
}

export function resolveVisibleWhatsAppGroupHistory(params: {
  authDir?: string;
  history: GroupHistoryEntry[];
  mode: ContextVisibilityMode;
  groupPolicy: "open" | "allowlist" | "disabled";
  groupAllowFrom: string[];
}): GroupHistoryEntry[] {
  return filterSupplementalContextItems({
    items: params.history,
    mode: params.mode,
    kind: "history",
    isSenderAllowed: (entry) =>
      resolveInboundSupplementalSenderAllowed({
        isGroup: true,
        groupPolicy: params.groupPolicy,
        allowFrom: params.groupAllowFrom,
        isSenderAllowed: (allowFrom) =>
          isWhatsAppSupplementalSenderAllowed({
            allowFrom,
            authDir: params.authDir,
            sender: entry.senderJid ? { jid: entry.senderJid } : null,
          }),
      }),
  }).items;
}

export function resolveVisibleWhatsAppReplyContext(params: {
  msg: AdmittedWebInboundMessage;
  authDir?: string;
  mode: ContextVisibilityMode;
  groupPolicy: "open" | "allowlist" | "disabled";
  groupAllowFrom: string[];
}): WhatsAppReplyContext | null {
  const replyTo = getReplyContext(params.msg, params.authDir);
  if (!replyTo) {
    return null;
  }
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const previewBody = [
    replyTo.body,
    formatMediaPlaceholderText(replyTo.media ? [replyTo.media] : []),
  ]
    .filter(Boolean)
    .join("\n");
  const senderAllowed = resolveInboundSupplementalSenderAllowed({
    isGroup: admission.conversation.kind === "group",
    groupPolicy: params.groupPolicy,
    allowFrom: params.groupAllowFrom,
    isSenderAllowed: (allowFrom) =>
      isWhatsAppSupplementalSenderAllowed({
        allowFrom,
        authDir: params.authDir,
        sender: replyTo.sender,
      }),
  });
  const visible = filterChannelInboundQuoteContext(params.mode, {
    id: replyTo.id,
    body: previewBody,
    sender: replyTo.sender?.label ?? undefined,
    senderAllowed,
  });
  return visible ? { ...replyTo, body: visible.body ?? "" } : null;
}
