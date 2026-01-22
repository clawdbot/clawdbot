import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  createMattermostDirectChannel,
  createMattermostPost,
  fetchMattermostMe,
  fetchMattermostUserByUsername,
  normalizeMattermostBaseUrl,
  uploadMattermostFile,
  type MattermostUser,
} from "./client.js";

export type MattermostSendOpts = {
  botToken?: string;
  baseUrl?: string;
  accountId?: string;
  mediaUrl?: string;
  replyToId?: string;
};

export type MattermostSendResult = {
  messageId: string;
  channelId: string;
};

type MattermostTarget =
  | { kind: "channel"; id: string }
  | { kind: "user"; id?: string; username?: string };

const botUserCache = new Map<string, MattermostUser>();
const userByNameCache = new Map<string, MattermostUser>();

const getCore = () => getMattermostRuntime();

function cacheKey(baseUrl: string, token: string): string {
  return `${baseUrl}::${token}`;
}

function normalizeMessage(text: string, mediaUrl?: string): string {
  const trimmed = text.trim();
  const media = mediaUrl?.trim();
  return [trimmed, media].filter(Boolean).join("\n");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function parseMattermostTarget(raw: string): MattermostTarget {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Recipient is required for Mattermost sends");
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    if (!id) throw new Error("Channel id is required for Mattermost sends");
    return { kind: "channel", id };
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    if (!id) throw new Error("User id is required for Mattermost sends");
    return { kind: "user", id };
  }
  if (lower.startsWith("mattermost:")) {
    const id = trimmed.slice("mattermost:".length).trim();
    if (!id) throw new Error("User id is required for Mattermost sends");
    return { kind: "user", id };
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    if (!username) {
      throw new Error("Username is required for Mattermost sends");
    }
    return { kind: "user", username };
  }
  return { kind: "channel", id: trimmed };
}

async function resolveBotUser(baseUrl: string, token: string): Promise<MattermostUser> {
  const key = cacheKey(baseUrl, token);
  const cached = botUserCache.get(key);
  if (cached) return cached;
  const client = createMattermostClient({ baseUrl, botToken: token });
  const user = await fetchMattermostMe(client);
  botUserCache.set(key, user);
  return user;
}

async function resolveUserIdByUsername(params: {
  baseUrl: string;
  token: string;
  username: string;
}): Promise<string> {
  const { baseUrl, token, username } = params;
  const key = `${cacheKey(baseUrl, token)}::${username.toLowerCase()}`;
  const cached = userByNameCache.get(key);
  if (cached?.id) return cached.id;
  const client = createMattermostClient({ baseUrl, botToken: token });
  const user = await fetchMattermostUserByUsername(client, username);
  userByNameCache.set(key, user);
  return user.id;
}

async function resolveTargetChannelId(params: {
  target: MattermostTarget;
  baseUrl: string;
  token: string;
}): Promise<string> {
  if (params.target.kind === "channel") return params.target.id;
  const userId = params.target.id
    ? params.target.id
    : await resolveUserIdByUsername({
        baseUrl: params.baseUrl,
        token: params.token,
        username: params.target.username ?? "",
      });
  const botUser = await resolveBotUser(params.baseUrl, params.token);
  const client = createMattermostClient({
    baseUrl: params.baseUrl,
    botToken: params.token,
  });
  const channel = await createMattermostDirectChannel(client, [botUser.id, userId]);
  return channel.id;
}

export async function sendMessageMattermost(
  to: string,
  text: string,
  opts: MattermostSendOpts = {},
): Promise<MattermostSendResult> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const cfg = core.config.loadConfig();
  const account = resolveMattermostAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = opts.botToken?.trim() || account.botToken?.trim();
  if (!token) {
    throw new Error(
      `Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`,
    );
  }
  const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`,
    );
  }

  const target = parseMattermostTarget(to);
  const channelId = await resolveTargetChannelId({
    target,
    baseUrl,
    token,
  });

  const client = createMattermostClient({ baseUrl, botToken: token });
  let message = text?.trim() ?? "";
  let fileIds: string[] | undefined;
  let uploadError: Error | undefined;
  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    try {
      const media = await core.media.loadWebMedia(mediaUrl);
      const fileInfo = await uploadMattermostFile(client, {
        channelId,
        buffer: media.buffer,
        fileName: media.fileName ?? "upload",
        contentType: media.contentType ?? undefined,
      });
      fileIds = [fileInfo.id];
    } catch (err) {
      uploadError = err instanceof Error ? err : new Error(String(err));
      if (core.logging.shouldLogVerbose()) {
        logger.debug?.(
          `mattermost send: media upload failed, falling back to URL text: ${String(err)}`,
        );
      }
      message = normalizeMessage(message, isHttpUrl(mediaUrl) ? mediaUrl : "");
    }
  }

  if (!message && (!fileIds || fileIds.length === 0)) {
    if (uploadError) {
      throw new Error(`Mattermost media upload failed: ${uploadError.message}`);
    }
    throw new Error("Mattermost message is empty");
  }

  const post = await createMattermostPost(client, {
    channelId,
    message,
    rootId: opts.replyToId,
    fileIds,
  });

  core.channel.activity.record({
    channel: "mattermost",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: post.id ?? "unknown",
    channelId,
  };
}
