import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  fetchMattermostChannel,
  fetchMattermostUser,
  sendMattermostTyping,
  updateMattermostPost,
  type MattermostChannel,
  type MattermostClient,
  type MattermostUser,
} from "./client.js";
import { buildButtonProps, type MattermostInteractionResponse } from "./interactions.js";

export type MattermostMediaKind = "image" | "audio" | "video" | "document" | "unknown";

export type MattermostMediaInfo = {
  path: string;
  contentType?: string;
  kind: MattermostMediaKind;
};

const CHANNEL_CACHE_TTL_MS = 5 * 60_000;
const USER_CACHE_TTL_MS = 10 * 60_000;

type SaveRemoteMedia = (params: {
  url: string;
  requestInit?: RequestInit;
  filePathHint?: string;
  maxBytes: number;
  ssrfPolicy?: { allowedHostnames?: string[] };
}) => Promise<{ path: string; contentType?: string | null }>;

export function createMattermostMonitorResources(params: {
  accountId: string;
  callbackUrl: string;
  client: MattermostClient;
  logger: { debug?: (...args: unknown[]) => void };
  mediaMaxBytes: number;
  saveRemoteMedia: SaveRemoteMedia;
  mediaKindFromMime: (contentType?: string) => MattermostMediaKind | null | undefined;
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
      cache.set(key, { value, expiresAt });
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
      try {
        const saved = await saveRemoteMedia({
          url: `${client.apiBaseUrl}/files/${fileId}`,
          requestInit: {
            headers: {
              Authorization: `Bearer ${client.token}`,
            },
          },
          filePathHint: fileId,
          maxBytes: mediaMaxBytes,
          ssrfPolicy: { allowedHostnames: [new URL(client.baseUrl).hostname] },
        });
        const contentType = saved.contentType ?? undefined;
        out.push({
          path: saved.path,
          contentType,
          kind: mediaKindFromMime(contentType) ?? "unknown",
        });
      } catch (err) {
        logger.debug?.(`mattermost: failed to download file ${fileId}: ${String(err)}`);
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
