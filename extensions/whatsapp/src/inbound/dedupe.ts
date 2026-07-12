// Whatsapp plugin module implements dedupe behavior.
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

export const WHATSAPP_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const RECENT_WEB_MESSAGE_MAX = 5000;
const RECENT_OUTBOUND_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_OUTBOUND_MESSAGE_MAX = 5000;

const claimableInboundMessages = createClaimableDedupe({
  ttlMs: WHATSAPP_INBOUND_DEDUPE_TTL_MS,
  memoryMaxSize: RECENT_WEB_MESSAGE_MAX,
});
const recentOutboundMessages = createDedupeCache({
  ttlMs: RECENT_OUTBOUND_MESSAGE_TTL_MS,
  maxSize: RECENT_OUTBOUND_MESSAGE_MAX,
});

export class WhatsAppRetryableInboundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WhatsAppRetryableInboundError";
  }
}

function buildMessageKey(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): string | null {
  const accountId = params.accountId.trim();
  const remoteJid = params.remoteJid.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !remoteJid || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${remoteJid}:${messageId}`;
}

export function resetWebInboundDedupe(): void {
  claimableInboundMessages.clearMemory();
  recentOutboundMessages.clear();
}

type RecentInboundMessageClaimKind = "claimed" | "duplicate" | "inflight";

export async function claimRecentInboundMessageDelivery(
  key: string,
): Promise<RecentInboundMessageClaimKind> {
  const claim = await claimableInboundMessages.claim(key);
  return claim.kind;
}

export async function commitRecentInboundMessage(key: string): Promise<void> {
  await claimableInboundMessages.commit(key);
}

export function releaseRecentInboundMessage(key: string, error?: unknown): void {
  claimableInboundMessages.release(key, { error });
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
  messageId: string;
}): boolean {
  const key = buildMessageKey(params);
  if (!key) {
    return false;
  }
  return recentOutboundMessages.peek(key);
}
