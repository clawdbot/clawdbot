// Whatsapp plugin module implements dedupe behavior.
import {
  isHostedLidUser,
  isHostedPnUser,
  isJidGroup,
  jidDecode,
  jidEncode,
  jidNormalizedUser,
} from "baileys";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";

const RECENT_OUTBOUND_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_OUTBOUND_MESSAGE_MAX = 5000;
const recentOutboundMessages = createDedupeCache({
  ttlMs: RECENT_OUTBOUND_MESSAGE_TTL_MS,
  maxSize: RECENT_OUTBOUND_MESSAGE_MAX,
});

function buildMessageKey(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): string | null {
  const accountId = params.accountId.trim();
  const rawRemoteJid = params.remoteJid.trim();
  const hostedPhone = isHostedPnUser(rawRemoteJid);
  // Match Baileys cleanMessage: hosted domains collapse before device stripping.
  let remoteJid: string;
  if (hostedPhone || isHostedLidUser(rawRemoteJid)) {
    const decodedJid = jidDecode(rawRemoteJid);
    if (!decodedJid) {
      return null;
    }
    remoteJid = jidEncode(decodedJid.user, hostedPhone ? "s.whatsapp.net" : "lid");
  } else {
    remoteJid = jidNormalizedUser(rawRemoteJid);
  }
  const messageId = params.messageId.trim();
  if (!accountId || !remoteJid || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${remoteJid}:${messageId}`;
}

export function resetWebInboundDedupe(): void {
  recentOutboundMessages.clear();
}

export function rememberRecentOutboundMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): void {
  const key = buildMessageKey(params);
  if (!key) {
    return;
  }
  recentOutboundMessages.check(key);
}

export function isRecentOutboundMessage(params: {
  accountId: string;
  remoteJid: string;
  alternateRemoteJid?: string;
  messageId: string;
}): boolean {
  const key = buildMessageKey(params);
  if (!key) {
    return false;
  }
  if (recentOutboundMessages.peek(key)) {
    return true;
  }
  // Baileys exposes phone/LID aliases for direct chats only; never cross groups.
  if (!params.alternateRemoteJid || isJidGroup(params.remoteJid)) {
    return false;
  }
  const alternateKey = buildMessageKey({
    ...params,
    remoteJid: params.alternateRemoteJid,
  });
  return alternateKey !== null && recentOutboundMessages.peek(alternateKey);
}
