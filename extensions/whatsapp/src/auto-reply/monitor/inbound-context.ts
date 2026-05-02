import {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
} from "openclaw/plugin-sdk/security-runtime";
import {
  getComparableIdentityValues,
  getReplyContext,
  type WhatsAppIdentity,
  type WhatsAppReplyContext,
} from "../../identity.js";
import { normalizeE164 } from "../../text-runtime.js";
import type { WebInboundMsg } from "../types.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

type ContextVisibilityMode = "all" | "allowlist" | "allowlist_quote";

function isWhatsAppSupplementalSenderAllowed(params: {
  allowFrom: string[];
  sender?: WhatsAppIdentity | null;
}): boolean {
  if (params.allowFrom.includes("*")) {
    return true;
  }
  const senderValues = new Set(getComparableIdentityValues(params.sender));
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
  history: GroupHistoryEntry[];
  mode: ContextVisibilityMode;
  groupPolicy: "open" | "allowlist" | "disabled";
  groupAllowFrom: string[];
}): GroupHistoryEntry[] {
  if (params.groupPolicy !== "allowlist") {
    return params.history;
  }
  return filterSupplementalContextItems({
    items: params.history,
    mode: params.mode,
    kind: "history",
    isSenderAllowed: (entry) =>
      isWhatsAppSupplementalSenderAllowed({
        allowFrom: params.groupAllowFrom,
        sender: entry.senderJid ? { jid: entry.senderJid } : null,
      }),
  }).items;
}

export function resolveVisibleWhatsAppReplyContext(params: {
  msg: WebInboundMsg;
  authDir?: string;
  mode: ContextVisibilityMode;
  groupPolicy: "open" | "allowlist" | "disabled";
  groupAllowFrom: string[];
}): WhatsAppReplyContext | null {
  const replyTo = getReplyContext(params.msg, params.authDir);
  if (!replyTo) {
    return null;
  }
  const include = evaluateSupplementalContextVisibility({
    mode: params.mode,
    kind: "quote",
    senderAllowed:
      params.msg.chatType !== "group" || params.groupPolicy !== "allowlist"
        ? true
        : isWhatsAppSupplementalSenderAllowed({
            allowFrom: params.groupAllowFrom,
            sender: replyTo.sender,
          }),
  }).include;
  return include ? replyTo : null;
}
