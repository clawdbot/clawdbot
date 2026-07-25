// Mattermost plugin module implements monitor resources behavior.
import {
  buildChannelInboundMediaPayload,
  formatInboundMediaUnavailableText,
  formatMediaPlaceholderText,
  toInboundMediaFacts,
  type ChannelInboundMediaPayload,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { MediaKind } from "openclaw/plugin-sdk/media-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildMattermostApiUrl,
  fetchMattermostChannel,
  fetchMattermostUser,
  sendMattermostTyping,
  updateMattermostPost,
  type MattermostChannel,
  type MattermostClient,
  type MattermostUser,
} from "./client.js";
import { buildButtonProps, type MattermostInteractionResponse } from "./interactions.js";

type MattermostMediaInfo = Omit<MediaPlaceholderTextFact, "kind" | "url"> & { kind: MediaKind };

export function buildMattermostInboundMediaPayload(
  media: readonly MattermostMediaInfo[],
): ChannelInboundMediaPayload {
  return buildChannelInboundMediaPayload(toInboundMediaFacts(media));
}

export function formatMattermostPendingMediaText(params: {
  body: string;
  media: readonly MediaPlaceholderTextFact[];
}): string {
  return [params.body, formatMediaPlaceholderText(params.media)].filter(Boolean).join("\n").trim();
}

export function formatMattermostInboundMediaText(params: {
  body: string;
  nativeMedia: readonly MediaPlaceholderTextFact[];
  materializedMedia: readonly MediaPlaceholderTextFact[];
}): string {
  const materializedCount = params.materializedMedia.filter(
    (media) => Boolean(media.path) || Boolean(media.url),
  ).length;
  const unavailableCount = Math.max(0, params.nativeMedia.length - materializedCount);
  if (unavailableCount === 0) {
    return params.body;
  }
  return formatInboundMediaUnavailableText({
    body: params.body,
    notice: `[mattermost ${unavailableCount > 1 ? `${unavailableCount} attachments` : "attachment"} unavailable]`,
  });
}

const CHANNEL_CACHE_TTL_MS = 5 * 60_000;
const USER_CACHE_TTL_MS = 10 * 60_000;
const MONITOR_RESOURCE_CACHE_MAX_ENTRIES = 1000;
// Match Telegram/Tlon inbound media: header wait is independent of body idle.
const MATTERMOST_MEDIA_RESPONSE_HEADER_TIMEOUT_MS = 120_000;
const MATTERMOST_MEDIA_READ_IDLE_TIMEOUT_MS = 30_000;

type SaveRemoteMedia = (params: {
  url: string;
  requestInit?: RequestInit;
  filePathHint?: string;
  maxBytes: number;
  ssrfPolicy?: { allowedHostnames?: string[] };
  responseHeaderTimeoutMs?: number;
  readIdleTimeoutMs?: number;
}) => Promise<{ path: string; contentType?: string | null }>;

export function createMattermostMonitorResources(params: {
  accountId: string;
  callbackUrl: string;
  client: MattermostClient;
  logger: { debug?: (...args: unknown[]) => void };
  mediaMaxBytes: number;
  saveRemoteMedia: SaveRemoteMedia;
  mediaKindFromMime: (contentType?: string) => MediaKind | null | undefined;
}) {
  const {
    accountId,
    callbackUrl,
    client,
    logger,
    mediaMaxBytes,
    saveRemoteMedia,
    mediaKindFromMime,
  } = params;
  const channelCache = new Map<string, { value: MattermostChannel | null; expiresAt: number }>();
  const userCache = new Map<string, { value: MattermostUser | null; expiresAt: number }>();

  const getCachedValue = <T>(
    cache: Map<string, { value: T | null; expiresAt: number }>,
    key: string,
    nowMs: number | undefined,
  ): T | null | undefined => {
    const cached = cache.get(key);
    if (!cached) {
      return undefined;
    }
    if (nowMs !== undefined && cached.expiresAt > nowMs) {
      return cached.value;
    }
    cache.delete(key);
    return undefined;
  };

  const setCachedValue = <T>(
    cache: Map<string, { value: T | null; expiresAt: number }>,
    key: string,
    value: T | null,
    ttlMs: number,
    rawNowMs: number,
  ): void => {
    const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNowMs });
    if (expiresAt !== undefined) {
      // Concurrent misses can resolve the same key out of order. Reinsert on
      // writes so the cap keeps the most recently resolved resources.
      cache.delete(key);
      cache.set(key, { value, expiresAt });
      pruneMapToMaxSize(cache, MONITOR_RESOURCE_CACHE_MAX_ENTRIES);
    }
  };

  const resolveMattermostMedia = async (
    fileIds?: string[] | null,
  ): Promise<MattermostMediaInfo[]> => {
    const ids = normalizeStringEntries(fileIds ?? []);
    if (ids.length === 0) {
      return [];
    }
    const out: MattermostMediaInfo[] = [];
    for (const fileId of ids) {
      let downloadUrl: string;
      try {
        downloadUrl = buildMattermostApiUrl(client.baseUrl, `/files/${fileId}`);
      } catch (err) {
        logger.debug?.(`mattermost: failed to resolve file ${fileId}: ${String(err)}`);
        // Keep the fact list aligned one-per-native-file so a rejected ID cannot
        // shift later attachments' payload positions; no download is attempted.
        out.push({ kind: "unknown" });
        continue;
      }
      try {
        const saved = await saveRemoteMedia({
          url: downloadUrl,
          requestInit: {
            headers: {
              Authorization: `Bearer ${client.token}`,
            },
          },
          filePathHint: fileId,
          maxBytes: mediaMaxBytes,
          ssrfPolicy: { allowedHostnames: [new URL(client.baseUrl).hostname] },
          // Without these, a Mattermost host that never returns headers can stall
          // inbound preprocessing indefinitely (idle timeout never starts).
          responseHeaderTimeoutMs: MATTERMOST_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
          readIdleTimeoutMs: MATTERMOST_MEDIA_READ_IDLE_TIMEOUT_MS,
        });
        const contentType = saved.contentType ?? undefined;
        out.push({
          path: saved.path,
          contentType,
          kind: mediaKindFromMime(contentType) ?? "unknown",
        });
      } catch (err) {
        logger.debug?.(`mattermost: failed to download file ${fileId}: ${String(err)}`);
        let contentType: string | undefined;
        try {
          const info = await client.request<{ mime_type?: string | null }>(`/files/${fileId}/info`);
          contentType = info.mime_type?.trim() || undefined;
        } catch (infoErr) {
          logger.debug?.(
            `mattermost: failed to resolve metadata for file ${fileId}: ${String(infoErr)}`,
          );
        }
        out.push({
          contentType,
          kind: mediaKindFromMime(contentType) ?? "unknown",
        });
      }
    }
    return out;
  };

  const sendTypingIndicator = async (channelId: string, parentId?: string) => {
    await sendMattermostTyping(client, { channelId, parentId });
  };

  const resolveChannelInfo = async (channelId: string): Promise<MattermostChannel | null> => {
    const rawNow = Date.now();
    const cached = getCachedValue(channelCache, channelId, asDateTimestampMs(rawNow));
    if (cached !== undefined) {
      return cached;
    }
    try {
      const info = await fetchMattermostChannel(client, channelId);
      setCachedValue(channelCache, channelId, info, CHANNEL_CACHE_TTL_MS, rawNow);
      return info;
    } catch (err) {
      logger.debug?.(`mattermost: channel lookup failed: ${String(err)}`);
      setCachedValue(channelCache, channelId, null, CHANNEL_CACHE_TTL_MS, rawNow);
      return null;
    }
  };

  const resolveUserInfo = async (userId: string): Promise<MattermostUser | null> => {
    const rawNow = Date.now();
    const cached = getCachedValue(userCache, userId, asDateTimestampMs(rawNow));
    if (cached !== undefined) {
      return cached;
    }
    try {
      const info = await fetchMattermostUser(client, userId);
      setCachedValue(userCache, userId, info, USER_CACHE_TTL_MS, rawNow);
      return info;
    } catch (err) {
      logger.debug?.(`mattermost: user lookup failed: ${String(err)}`);
      setCachedValue(userCache, userId, null, USER_CACHE_TTL_MS, rawNow);
      return null;
    }
  };

  const buildModelPickerProps = (
    channelId: string,
    buttons: Array<unknown>,
  ): Record<string, unknown> | undefined =>
    buildButtonProps({
      callbackUrl,
      accountId,
      channelId,
      buttons,
    });

  const updateModelPickerPost = async (paramsLocal: {
    channelId: string;
    postId: string;
    message: string;
    buttons?: Array<unknown>;
  }): Promise<MattermostInteractionResponse> => {
    const props = buildModelPickerProps(paramsLocal.channelId, paramsLocal.buttons ?? []) ?? {
      attachments: [],
    };
    await updateMattermostPost(client, paramsLocal.postId, {
      message: paramsLocal.message,
      props,
    });
    return {};
  };

  return {
    resolveMattermostMedia,
    sendTypingIndicator,
    resolveChannelInfo,
    resolveUserInfo,
    updateModelPickerPost,
  };
}
