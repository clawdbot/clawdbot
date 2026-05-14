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

  const resolveMattermostMedia = async (
    fileIds?: string[] | null,
  ): Promise<MattermostMediaInfo[]> => {
    const ids = (fileIds ?? []).map((id) => id?.trim()).filter(Boolean);
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
    const cached = channelCache.get(channelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchMattermostChannel(client, channelId);
      channelCache.set(channelId, {
        value: info,
        expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
      });
      return info;
    } catch (err) {
      logger.debug?.(`mattermost: channel lookup failed: ${String(err)}`);
      channelCache.set(channelId, {
        value: null,
        expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
      });
      return null;
    }
  };

  const resolveUserInfo = async (userId: string): Promise<MattermostUser | null> => {
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchMattermostUser(client, userId);
      userCache.set(userId, {
        value: info,
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
      });
      return info;
    } catch (err) {
      logger.debug?.(`mattermost: user lookup failed: ${String(err)}`);
      userCache.set(userId, {
        value: null,
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
      });
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

  const updateModelPickerPost = async (params: {
    channelId: string;
    postId: string;
    message: string;
    buttons?: Array<unknown>;
  }): Promise<MattermostInteractionResponse> => {
    const props = buildModelPickerProps(params.channelId, params.buttons ?? []) ?? {
      attachments: [],
    };
    await updateMattermostPost(client, params.postId, {
      message: params.message,
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
