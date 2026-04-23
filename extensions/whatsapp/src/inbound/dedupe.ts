import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

const RECENT_WEB_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_WEB_MESSAGE_MAX = 5000;
const RECENT_OUTBOUND_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_OUTBOUND_MESSAGE_MAX = 5000;

const claimableInboundMessages = createClaimableDedupe({
  ttlMs: RECENT_WEB_MESSAGE_TTL_MS,
  memoryMaxSize: RECENT_WEB_MESSAGE_MAX,
});
const recentOutboundMessages = createRecentMessageCache({
  ttlMs: RECENT_OUTBOUND_MESSAGE_TTL_MS,
  maxSize: RECENT_OUTBOUND_MESSAGE_MAX,
});

function createRecentMessageCache(options: { ttlMs: number; maxSize: number }) {
  const ttlMs = Math.max(0, options.ttlMs);
  const maxSize = Math.max(0, Math.floor(options.maxSize));
  const cache = new Map<string, number>();

  const prune = (now: number) => {
    if (ttlMs > 0) {
      const cutoff = now - ttlMs;
      for (const [key, timestamp] of cache) {
        if (timestamp < cutoff) {
          cache.delete(key);
        }
      }
    }
    while (cache.size > maxSize) {
      const oldest = cache.keys().next().value;
      if (!oldest) {
        break;
      }
      cache.delete(oldest);
    }
  };

  const peek = (key: string | null, now = Date.now()): boolean => {
    if (!key) {
      return false;
    }
    const timestamp = cache.get(key);
    if (timestamp === undefined) {
      return false;
    }
    if (ttlMs > 0 && now - timestamp >= ttlMs) {
      cache.delete(key);
      return false;
    }
    return true;
  };

  return {
    check: (key: string | null, now = Date.now()): boolean => {
      if (!key) {
        return false;
      }
      const existed = peek(key, now);
      cache.delete(key);
      cache.set(key, now);
      prune(now);
      return existed;
    },
    peek,
    clear: () => cache.clear(),
  };
}

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

export async function claimRecentInboundMessage(key: string): Promise<boolean> {
  const claim = await claimableInboundMessages.claim(key);
  return claim.kind === "claimed";
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
