// Whatsapp plugin module owns group metadata caching and hydration.
import type { AnyMessageContent, BaileysEventMap, GroupMetadata, WASocket } from "baileys";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  readWhatsAppBaileysCacheEntry,
  rememberWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysGroupMetadataCache,
} from "./baileys-cache.js";
import type { WhatsAppSocketListen } from "./lifecycle.js";
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
  listen: WhatsAppSocketListen;
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
  const groupMetadataGenerations = new Map<string, object>();
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
    groupMetadataGenerations.set(jid, {});
    rememberWhatsAppBaileysCacheEntry(params.baileysCache, jid, meta, GROUP_META_TTL_MS);
    rememberGroupMetadataCacheEntry(reconnectCache, jid, summarizeForReconnect(meta));
    localCache.delete(jid);
  };

  const forgetFullMetadata = (jid: string) => {
    groupMetadataGenerations.set(jid, {});
    params.baileysCache?.delete(jid);
    reconnectCache.delete(jid);
    localCache.delete(jid);
  };

  const get = async (jid: string): Promise<LocalGroupMetadataCacheEntry> => {
    for (;;) {
      if (closed) {
        return { expires: resolveGroupMetadataExpiresAt() ?? 0 };
      }
      const cached = readGroupMetadataCacheEntry(localCache, jid);
      if (cached) {
        return cached;
      }
      const generation = groupMetadataGenerations.get(jid);
      try {
        const hydratedEntry = params.baileysCache?.get(jid);
        const providerMetadata = params.baileysCache
          ? readWhatsAppBaileysCacheEntry(params.baileysCache, jid)
          : undefined;
        const hydratedMetadata = providerMetadata?.participants?.length
          ? providerMetadata
          : undefined;
        const meta =
          hydratedMetadata ?? (await (params.getCurrentSock() ?? params.sock).groupMetadata(jid));
        if (closed || groupMetadataGenerations.get(jid) !== generation) {
          continue;
        }
        const entry = await summarize(meta);
        // Membership updates and shutdown can happen during either provider lookup or LID mapping.
        // Publish all caches together only while this JID still owns its exact live generation.
        if (closed || groupMetadataGenerations.get(jid) !== generation) {
          continue;
        }
        if (hydratedMetadata && hydratedEntry) {
          // Reusing provider-owned membership must not extend its authoritative freshness window.
          entry.expires = hydratedEntry.expiresAt;
        } else {
          rememberWhatsAppBaileysCacheEntry(params.baileysCache, jid, meta, GROUP_META_TTL_MS);
        }
        groupMetadataGenerations.set(jid, {});
        rememberGroupMetadataCacheEntry(reconnectCache, jid, {
          subject: entry.subject,
          expires: entry.expires,
        });
        rememberGroupMetadataCacheEntry(localCache, jid, entry);
        return entry;
      } catch (error) {
        if (closed || groupMetadataGenerations.get(jid) !== generation) {
          continue;
        }
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
    const listen = <Event extends keyof BaileysEventMap>(
      event: Event,
      listener: (arg: BaileysEventMap[Event]) => void,
    ) => {
      detachListeners.push(params.listen(event, listener));
    };

    listen("groups.upsert", (groups) => {
      for (const group of groups) {
        if (group.id) {
          rememberFullUpdate(group.id, group);
        }
      }
    });
    listen("groups.update", (updates) => {
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
    });
    listen("group-participants.update", (update) => {
      forgetFullMetadata(update.id);
    });

    void (async () => {
      try {
        const groups = await params.sock.groupFetchAllParticipating();
        if (closed) {
          return;
        }
        for (const [jid, meta] of Object.entries(groups ?? {})) {
          if (meta && !groupMetadataGenerations.has(jid)) {
            rememberGroupMetadataCacheEntry(reconnectCache, jid, summarizeForReconnect(meta));
            rememberWhatsAppBaileysCacheEntry(params.baileysCache, jid, meta, GROUP_META_TTL_MS);
            groupMetadataGenerations.set(jid, {});
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
