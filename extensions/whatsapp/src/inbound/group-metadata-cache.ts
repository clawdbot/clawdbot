// Whatsapp plugin module owns group metadata caching and hydration.
import type { AnyMessageContent, GroupMetadata, WASocket } from "baileys";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  rememberWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysGroupMetadataCache,
} from "./baileys-cache.js";
import {
  addWhatsAppOutboundMentionsToContent,
  mayContainWhatsAppOutboundMention,
  resolveWhatsAppOutboundMentions,
  type WhatsAppOutboundMentionParticipant,
} from "./outbound-mentions.js";
import { isJidGroup } from "./runtime-api.js";

const GROUP_META_TTL_MS = 5 * 60 * 1000;
const WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES = 500;

type WhatsAppGroupMetadataCacheEntry = {
  subject?: string;
  expires: number;
};

export type WhatsAppGroupMetadataCache = Map<string, WhatsAppGroupMetadataCacheEntry>;

type LocalGroupMetadataCacheEntry = WhatsAppGroupMetadataCacheEntry & {
  participants?: string[];
  mentionParticipants?: WhatsAppOutboundMentionParticipant[];
};

type GroupMetadataCacheOwnerParams = {
  sock: WASocket;
  getCurrentSock: () => WASocket | null;
  resolveInboundJid: (jid: string | null | undefined) => Promise<string | null>;
  reconnectCache?: WhatsAppGroupMetadataCache;
  baileysCache?: WhatsAppBaileysGroupMetadataCache;
  listen: (event: string, listener: (...args: unknown[]) => void) => () => void;
  logVerbose: (message: string) => void;
  logHydrationWarning: (error: string) => void;
};

function resolveGroupMetadataExpiresAt(nowRaw = Date.now()): number | undefined {
  const now = asDateTimestampMs(nowRaw);
  return now === undefined
    ? undefined
    : resolveExpiresAtMsFromDurationMs(GROUP_META_TTL_MS, { nowMs: now });
}

function rememberGroupMetadataCacheEntry<T extends WhatsAppGroupMetadataCacheEntry>(
  cache: Map<string, T>,
  jid: string,
  entry: T,
): void {
  if (asDateTimestampMs(entry.expires) === undefined) {
    cache.delete(jid);
    return;
  }
  if (cache.has(jid)) {
    cache.delete(jid);
  }
  cache.set(jid, entry);

  while (cache.size > WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.delete(oldest.value);
  }
}

function readGroupMetadataCacheEntry<T extends WhatsAppGroupMetadataCacheEntry>(
  cache: Map<string, T>,
  jid: string,
): T | null {
  const entry = cache.get(jid);
  if (!entry) {
    return null;
  }
  const now = asDateTimestampMs(Date.now());
  const expires = asDateTimestampMs(entry.expires);
  if (now === undefined || expires === undefined || expires <= now) {
    cache.delete(jid);
    return null;
  }
  cache.delete(jid);
  cache.set(jid, entry);
  return entry;
}

export function createWhatsAppGroupMetadataCacheOwner(params: GroupMetadataCacheOwnerParams) {
  const reconnectCache = params.reconnectCache ?? new Map();
  const localCache = new Map<string, LocalGroupMetadataCacheEntry>();
  const publishedJids = new Set<string>();
  const invalidatedJids = new Set<string>();
  const detachListeners: Array<() => void> = [];
  let closed = false;
  let started = false;

  const summarize = async (meta: GroupMetadata): Promise<LocalGroupMetadataCacheEntry> => {
    const participantEntries = await Promise.all(
      meta.participants?.map(async (participant) => {
        const mapped = await params.resolveInboundJid(participant.id);
        return {
          display: mapped ?? participant.id,
          mention: {
            id: participant.id,
            lid: participant.lid,
            phoneNumber: participant.phoneNumber,
            e164: mapped,
          } satisfies WhatsAppOutboundMentionParticipant,
        };
      }) ?? [],
    );
    return {
      subject: meta.subject,
      participants: participantEntries.map((entry) => entry.display).filter(Boolean),
      mentionParticipants: participantEntries.map((entry) => entry.mention),
      expires: resolveGroupMetadataExpiresAt() ?? 0,
    };
  };

  const summarizeForReconnect = (meta: GroupMetadata): WhatsAppGroupMetadataCacheEntry => ({
    subject: meta.subject,
    expires: resolveGroupMetadataExpiresAt() ?? Number.NaN,
  });

  const rememberFullUpdate = (jid: string, meta: GroupMetadata) => {
    if (closed) {
      return;
    }
    rememberWhatsAppBaileysCacheEntry(params.baileysCache, jid, meta, GROUP_META_TTL_MS);
    publishedJids.add(jid);
    invalidatedJids.delete(jid);
    rememberGroupMetadataCacheEntry(reconnectCache, jid, summarizeForReconnect(meta));
    localCache.delete(jid);
  };

  const forgetFullMetadata = (jid: string) => {
    params.baileysCache?.delete(jid);
    reconnectCache.delete(jid);
    localCache.delete(jid);
    publishedJids.delete(jid);
    invalidatedJids.add(jid);
  };

  const get = async (jid: string): Promise<LocalGroupMetadataCacheEntry> => {
    const cached = readGroupMetadataCacheEntry(localCache, jid);
    if (cached) {
      return cached;
    }
    try {
      const meta = await (params.getCurrentSock() ?? params.sock).groupMetadata(jid);
      rememberWhatsAppBaileysCacheEntry(params.baileysCache, jid, meta, GROUP_META_TTL_MS);
      publishedJids.add(jid);
      const entry = await summarize(meta);
      rememberGroupMetadataCacheEntry(reconnectCache, jid, {
        subject: entry.subject,
        expires: entry.expires,
      });
      rememberGroupMetadataCacheEntry(localCache, jid, entry);
      return entry;
    } catch (error) {
      const hydrated = readGroupMetadataCacheEntry(reconnectCache, jid);
      if (hydrated) {
        rememberGroupMetadataCacheEntry(localCache, jid, hydrated);
        params.logVerbose(
          `Using cached group metadata for ${jid} after fetch failure: ${String(error)}`,
        );
        return hydrated;
      }
      params.logVerbose(`Failed to fetch group metadata for ${jid}: ${String(error)}`);
      return { expires: resolveGroupMetadataExpiresAt() ?? 0 };
    }
  };

  const resolveOutboundMentions = async (
    jid: string,
    text: string,
  ): Promise<{ text: string; mentionedJids: string[] }> => {
    if (isJidGroup(jid) !== true || !mayContainWhatsAppOutboundMention(text)) {
      return { text, mentionedJids: [] };
    }
    const meta = await get(jid);
    return resolveWhatsAppOutboundMentions({
      chatJid: jid,
      text,
      participants: meta.mentionParticipants,
    });
  };

  const applyOutboundMentions = async (
    jid: string,
    content: AnyMessageContent,
  ): Promise<AnyMessageContent> => {
    if ("text" in content && typeof content.text === "string") {
      const resolved = await resolveOutboundMentions(jid, content.text);
      return addWhatsAppOutboundMentionsToContent(
        { ...content, text: resolved.text } as AnyMessageContent,
        resolved.mentionedJids,
      );
    }
    const caption = (content as { caption?: unknown }).caption;
    if (typeof caption === "string") {
      const resolved = await resolveOutboundMentions(jid, caption);
      return addWhatsAppOutboundMentionsToContent(
        { ...content, caption: resolved.text } as AnyMessageContent,
        resolved.mentionedJids,
      );
    }
    return content;
  };

  const start = () => {
    if (started || closed) {
      return;
    }
    started = true;
    const listen = (event: string, listener: (...args: unknown[]) => void) => {
      detachListeners.push(params.listen(event, listener));
    };

    listen("groups.upsert", ((groups: GroupMetadata[]) => {
      for (const group of groups) {
        if (group.id) {
          rememberFullUpdate(group.id, group);
        }
      }
    }) as unknown as (...args: unknown[]) => void);
    listen("groups.update", ((updates: Partial<GroupMetadata>[]) => {
      for (const update of updates) {
        if (!update.id) {
          continue;
        }
        if (typeof update.subject === "string" && Array.isArray(update.participants)) {
          rememberFullUpdate(update.id, update as GroupMetadata);
          continue;
        }
        forgetFullMetadata(update.id);
      }
    }) as unknown as (...args: unknown[]) => void);
    listen("group-participants.update", ((update: { id: string }) => {
      forgetFullMetadata(update.id);
    }) as unknown as (...args: unknown[]) => void);

    void (async () => {
      try {
        const groups = await params.sock.groupFetchAllParticipating();
        if (closed) {
          return;
        }
        for (const [jid, meta] of Object.entries(groups ?? {})) {
          if (meta && !publishedJids.has(jid) && !invalidatedJids.has(jid)) {
            rememberGroupMetadataCacheEntry(reconnectCache, jid, summarizeForReconnect(meta));
            rememberWhatsAppBaileysCacheEntry(params.baileysCache, jid, meta, GROUP_META_TTL_MS);
            publishedJids.add(jid);
          }
        }
        params.logVerbose(
          `Hydrated ${Object.keys(groups ?? {}).length} participating groups on connect`,
        );
      } catch (error) {
        const formatted = String(error);
        params.logHydrationWarning(formatted);
        params.logVerbose(`Failed to hydrate participating groups on connect: ${formatted}`);
      }
    })();
  };

  const close = () => {
    closed = true;
    for (const detach of detachListeners.splice(0)) {
      detach();
    }
  };

  return {
    start,
    close,
    get,
    resolveOutboundMentions,
    applyOutboundMentions,
  } as const;
}

export type WhatsAppGroupMetadataCacheOwner = ReturnType<
  typeof createWhatsAppGroupMetadataCacheOwner
>;
