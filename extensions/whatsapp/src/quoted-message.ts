import type { MiscMessageGenerationOptions } from "@whiskeysockets/baileys";
import { jidToE164 } from "./text-runtime.js";

// ── Inbound message metadata cache ──────────────────────────────────────
// Maps messageId → { participant, participantE164, body, fromMe } so the
// outbound adapter can
// populate the quote key with the sender JID and preview text even though
// the outbound path only receives a bare messageId string.

type QuotedMeta = {
  participant?: string;
  participantE164?: string;
  body?: string;
  fromMe?: boolean;
};
type CacheEntry = QuotedMeta & { ts: number };
type QuotedMetaLookup = QuotedMeta & { remoteJid: string };

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();

function makeCacheKey(accountId: string, remoteJid: string, messageId: string): string {
  return `${accountId}:${remoteJid}:${messageId}`;
}

export function cacheInboundMessageMeta(
  accountId: string,
  remoteJid: string,
  messageId: string,
  meta: QuotedMeta,
): void {
  if (!accountId || !messageId || !remoteJid) {
    return;
  }
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
    }
  }
  cache.set(makeCacheKey(accountId, remoteJid, messageId), { ...meta, ts: Date.now() });
}

export function lookupInboundMessageMeta(
  accountId: string,
  remoteJid: string,
  messageId: string,
): QuotedMeta | undefined {
  const cacheKey = makeCacheKey(accountId, remoteJid, messageId);
  const entry = cache.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(cacheKey);
    return undefined;
  }
  return {
    participant: entry.participant,
    participantE164: entry.participantE164,
    body: entry.body,
    fromMe: entry.fromMe,
  };
}

function normalizeComparableJid(jid: string | undefined): string | undefined {
  const normalized = jid?.trim().replace(/:\d+/, "").toLowerCase();
  return normalized || undefined;
}

function isGroupJid(jid: string | undefined): boolean {
  return Boolean(jid && jid.endsWith("@g.us"));
}

function areComparableE164sEqual(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = left?.trim();
  const normalizedRight = right?.trim();
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return normalizedLeft === normalizedRight;
}

function areComparableJidsEqual(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeComparableJid(left);
  const normalizedRight = normalizeComparableJid(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  const leftE164 = jidToE164(normalizedLeft);
  const rightE164 = jidToE164(normalizedRight);
  return Boolean(leftE164 && rightE164 && leftE164 === rightE164);
}

function matchesQuotedConversationTarget(targetJid: string, candidate: QuotedMetaLookup): boolean {
  if (areComparableJidsEqual(targetJid, candidate.remoteJid)) {
    return true;
  }
  if (isGroupJid(targetJid) || isGroupJid(candidate.remoteJid)) {
    return false;
  }
  return (
    areComparableJidsEqual(targetJid, candidate.participant) ||
    areComparableE164sEqual(jidToE164(targetJid) ?? undefined, candidate.participantE164)
  );
}

export function lookupInboundMessageMetaForTarget(
  accountId: string,
  targetJid: string,
  messageId: string,
): QuotedMetaLookup | undefined {
  if (!accountId || !messageId || !targetJid) {
    return undefined;
  }
  const exact = lookupInboundMessageMeta(accountId, targetJid, messageId);
  if (exact) {
    return {
      remoteJid: targetJid,
      participant: exact.participant,
      participantE164: exact.participantE164,
      body: exact.body,
      fromMe: exact.fromMe,
    };
  }
  const prefix = `${accountId}:`;
  const suffix = `:${messageId}`;
  let matched: QuotedMetaLookup | undefined;
  for (const [cacheKey, entry] of cache.entries()) {
    if (!cacheKey.startsWith(prefix) || !cacheKey.endsWith(suffix)) {
      continue;
    }
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      cache.delete(cacheKey);
      continue;
    }
    const remoteJid = cacheKey.slice(prefix.length, cacheKey.length - suffix.length);
    const candidate = {
      remoteJid,
      participant: entry.participant,
      participantE164: entry.participantE164,
      body: entry.body,
      fromMe: entry.fromMe,
    };
    if (!matchesQuotedConversationTarget(targetJid, candidate)) {
      continue;
    }
    if (matched) {
      return undefined;
    }
    matched = candidate;
  }
  return matched;
}

export function buildQuotedMessageOptions(params: {
  messageId?: string | null;
  remoteJid?: string | null;
  fromMe?: boolean;
  participant?: string;
  /** Original message text — shown in the quote preview bubble. */
  messageText?: string;
}): MiscMessageGenerationOptions | undefined {
  const id = params.messageId?.trim();
  const remoteJid = params.remoteJid?.trim();
  if (!id || !remoteJid) {
    return undefined;
  }
  return {
    quoted: {
      key: {
        remoteJid,
        id,
        fromMe: params.fromMe ?? false,
        participant: params.participant,
      },
      message: { conversation: params.messageText ?? "" },
    },
  } as MiscMessageGenerationOptions;
}
