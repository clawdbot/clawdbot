import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveSlackAccount } from "./accounts.js";
import { validateSlackBlocksArray } from "./blocks-input.js";
import { createSlackWebClient, getSlackWriteClient } from "./client.js";
import { buildSlackEditTextPayload } from "./edit-text.js";
import { resolveSlackMedia } from "./monitor/media.js";
import type { SlackMediaResult } from "./monitor/media.js";
import { sendMessageSlack } from "./send.js";
import { resolveSlackBotToken } from "./token.js";

export type SlackActionClientOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  token?: string;
  client?: WebClient;
};

export type SlackMessageSummary = {
  ts?: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{
    name?: string;
    count?: number;
    users?: string[];
  }>;
  /** File attachments on this message. Present when the message has files. */
  files?: Array<{
    id?: string;
    name?: string;
    mimetype?: string;
  }>;
};

export type SlackPin = {
  type?: string;
  message?: { ts?: string; text?: string };
  file?: { id?: string; name?: string };
};

function resolveToken(explicit?: string, accountId?: string, cfg?: OpenClawConfig): string {
  if (explicit?.trim()) {
    const token = resolveSlackBotToken(explicit);
    if (token) {
      return token;
    }
  }
  if (!cfg) {
    throw new Error(
      "Slack actions requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const resolvedCfg = requireRuntimeConfig(cfg, "Slack actions");
  const account = resolveSlackAccount({ cfg: resolvedCfg, accountId });
  const token = resolveSlackBotToken(account.botToken ?? undefined);
  if (!token) {
    logVerbose(
      `slack actions: missing bot token for account=${account.accountId} explicit=${Boolean(
        explicit,
      )} source=${account.botTokenSource ?? "unknown"}`,
    );
    throw new Error("SLACK_BOT_TOKEN or channels.slack.botToken is required for Slack actions");
  }
  return token;
}

function normalizeEmoji(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Emoji is required for Slack reactions");
  }
  return trimmed.replace(/^:+|:+$/g, "");
}

function hasSlackPlatformError(err: unknown, code: string): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return false;
  }
  return (data as { error?: unknown }).error === code;
}

async function getClient(opts: SlackActionClientOpts = {}, mode: "read" | "write" = "read") {
  if (opts.client) {
    return opts.client;
  }
  const token = resolveToken(opts.token, opts.accountId, opts.cfg);
  return mode === "write" ? getSlackWriteClient(token) : createSlackWebClient(token);
}

async function resolveBotUserId(client: WebClient) {
  const auth = await client.auth.test();
  if (!auth?.user_id) {
    throw new Error("Failed to resolve Slack bot user id");
  }
  return auth.user_id;
}

export async function reactSlackMessage(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: SlackActionClientOpts = {},
) {
  const client = await getClient(opts, "write");
  try {
    await client.reactions.add({
      channel: channelId,
      timestamp: messageId,
      name: normalizeEmoji(emoji),
    });
  } catch (err) {
    if (hasSlackPlatformError(err, "already_reacted")) {
      return;
    }
    throw err;
  }
}

export async function removeSlackReaction(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: SlackActionClientOpts = {},
) {
  const client = await getClient(opts, "write");
  try {
    await client.reactions.remove({
      channel: channelId,
      timestamp: messageId,
      name: normalizeEmoji(emoji),
    });
  } catch (err) {
    if (hasSlackPlatformError(err, "no_reaction")) {
      return;
    }
    throw err;
  }
}

export async function removeOwnSlackReactions(
  channelId: string,
  messageId: string,
  opts: SlackActionClientOpts = {},
): Promise<string[]> {
  const client = await getClient(opts, "write");
  const userId = await resolveBotUserId(client);
  const reactions = await listSlackReactions(channelId, messageId, { client });
  const toRemove = new Set<string>();
  for (const reaction of reactions ?? []) {
    const name = reaction?.name;
    if (!name) {
      continue;
    }
    const users = reaction?.users ?? [];
    if (users.includes(userId)) {
      toRemove.add(name);
    }
  }
  if (toRemove.size === 0) {
    return [];
  }
  await Promise.all(
    Array.from(toRemove, (name) =>
      removeSlackReaction(channelId, messageId, name, {
        ...opts,
        client,
      }),
    ),
  );
  return Array.from(toRemove);
}

export async function listSlackReactions(
  channelId: string,
  messageId: string,
  opts: SlackActionClientOpts = {},
): Promise<SlackMessageSummary["reactions"]> {
  const client = await getClient(opts);
  const result = await client.reactions.get({
    channel: channelId,
    timestamp: messageId,
    full: true,
  });
  const message = result.message as SlackMessageSummary | undefined;
  return message?.reactions ?? [];
}

export async function sendSlackMessage(
  to: string,
  content: string,
  opts: Omit<SlackActionClientOpts, "cfg"> & {
    cfg: OpenClawConfig;
    mediaUrl?: string;
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    threadTs?: string;
    replyBroadcast?: boolean;
    uploadFileName?: string;
    uploadTitle?: string;
    blocks?: (Block | KnownBlock)[];
  },
) {
  return await sendMessageSlack(to, content, {
    accountId: opts.accountId,
    cfg: opts.cfg,
    token: opts.token,
    mediaUrl: opts.mediaUrl,
    mediaAccess: opts.mediaAccess,
    mediaLocalRoots: opts.mediaLocalRoots,
    mediaReadFile: opts.mediaReadFile,
    client: opts.client,
    threadTs: opts.threadTs,
    replyBroadcast: opts.replyBroadcast,
    ...(opts.uploadFileName ? { uploadFileName: opts.uploadFileName } : {}),
    ...(opts.uploadTitle ? { uploadTitle: opts.uploadTitle } : {}),
    blocks: opts.blocks,
  });
}

export async function editSlackMessage(
  channelId: string,
  messageId: string,
  content: string,
  opts: SlackActionClientOpts & { blocks?: (Block | KnownBlock)[] } = {},
) {
  const client = await getClient(opts, "write");
  const blocks = opts.blocks == null ? undefined : validateSlackBlocksArray(opts.blocks);
  await client.chat.update({
    channel: channelId,
    ts: messageId,
    text: buildSlackEditTextPayload(content, blocks),
    ...(blocks ? { blocks } : {}),
  });
}

export async function deleteSlackMessage(
  channelId: string,
  messageId: string,
  opts: SlackActionClientOpts = {},
) {
  const client = await getClient(opts, "write");
  await client.chat.delete({
    channel: channelId,
    ts: messageId,
  });
}

export async function readSlackMessages(
  channelId: string,
  opts: SlackActionClientOpts & {
    limit?: number;
    before?: string;
    after?: string;
    threadId?: string;
    messageId?: string;
  } = {},
): Promise<{ messages: SlackMessageSummary[]; hasMore: boolean }> {
  const client = await getClient(opts);
  const exactMessageId = opts.messageId?.trim();
  const readLimit = exactMessageId ? 1 : opts.limit;
  const exactBounds = exactMessageId
    ? {
        inclusive: true,
        latest: exactMessageId,
        oldest: undefined,
      }
    : {
        latest: opts.before,
        oldest: opts.after,
      };

  // Use conversations.replies for thread messages, conversations.history for channel messages.
  if (opts.threadId) {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: opts.threadId,
      limit: readLimit,
      ...exactBounds,
    });
    const messages = ((result.messages ?? []) as SlackMessageSummary[]).filter((message) => {
      if (exactMessageId) {
        return message.ts === exactMessageId;
      }
      // conversations.replies includes the parent message; drop it for replies-only reads.
      return message.ts !== opts.threadId;
    });
    return {
      messages,
      hasMore: exactMessageId ? false : Boolean(result.has_more),
    };
  }

  const result = await client.conversations.history({
    channel: channelId,
    limit: readLimit,
    ...exactBounds,
  });
  const messages = ((result.messages ?? []) as SlackMessageSummary[]).filter(
    (message) => !exactMessageId || message.ts === exactMessageId,
  );
  return {
    messages,
    hasMore: exactMessageId ? false : Boolean(result.has_more),
  };
}

export async function getSlackMemberInfo(userId: string, opts: SlackActionClientOpts = {}) {
  const client = await getClient(opts);
  return await client.users.info({ user: userId });
}

export async function listSlackEmojis(opts: SlackActionClientOpts = {}) {
  const client = await getClient(opts);
  return await client.emoji.list();
}

export async function pinSlackMessage(
  channelId: string,
  messageId: string,
  opts: SlackActionClientOpts = {},
) {
  const client = await getClient(opts, "write");
  await client.pins.add({ channel: channelId, timestamp: messageId });
}

export async function unpinSlackMessage(
  channelId: string,
  messageId: string,
  opts: SlackActionClientOpts = {},
) {
  const client = await getClient(opts, "write");
  await client.pins.remove({ channel: channelId, timestamp: messageId });
}

export async function listSlackPins(
  channelId: string,
  opts: SlackActionClientOpts = {},
): Promise<SlackPin[]> {
  const client = await getClient(opts);
  const result = await client.pins.list({ channel: channelId });
  return (result.items ?? []) as SlackPin[];
}

type SlackFileInfoSummary = {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  channels?: unknown;
  groups?: unknown;
  ims?: unknown;
  shares?: unknown;
};

type SlackFileThreadShare = {
  channelId: string;
  ts?: string;
  threadTs?: string;
};

function normalizeSlackScopeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function collectSlackDirectShareChannelIds(file: SlackFileInfoSummary): Set<string> {
  const ids = new Set<string>();
  for (const group of [file.channels, file.groups, file.ims]) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const entry of group) {
      if (typeof entry !== "string") {
        continue;
      }
      const normalized = normalizeSlackScopeValue(entry);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }
  return ids;
}

function collectSlackShareMaps(file: SlackFileInfoSummary): Array<Record<string, unknown>> {
  if (!file.shares || typeof file.shares !== "object" || Array.isArray(file.shares)) {
    return [];
  }
  const shares = file.shares as Record<string, unknown>;
  return [shares.public, shares.private].filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value),
  );
}

function collectSlackSharedChannelIds(file: SlackFileInfoSummary): Set<string> {
  const ids = new Set<string>();
  for (const shareMap of collectSlackShareMaps(file)) {
    for (const channelId of Object.keys(shareMap)) {
      const normalized = normalizeSlackScopeValue(channelId);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }
  return ids;
}

function collectSlackThreadShares(
  file: SlackFileInfoSummary,
  channelId: string,
): SlackFileThreadShare[] {
  const matches: SlackFileThreadShare[] = [];
  for (const shareMap of collectSlackShareMaps(file)) {
    const rawEntries = shareMap[channelId];
    if (!Array.isArray(rawEntries)) {
      continue;
    }
    for (const rawEntry of rawEntries) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      const ts = typeof entry.ts === "string" ? normalizeSlackScopeValue(entry.ts) : undefined;
      const threadTs =
        typeof entry.thread_ts === "string" ? normalizeSlackScopeValue(entry.thread_ts) : undefined;
      matches.push({ channelId, ts, threadTs });
    }
  }
  return matches;
}

function hasSlackScopeMismatch(params: {
  file: SlackFileInfoSummary;
  channelId?: string;
  threadId?: string;
}): boolean {
  const channelId = normalizeSlackScopeValue(params.channelId);
  if (!channelId) {
    return false;
  }
  const threadId = normalizeSlackScopeValue(params.threadId);

  const directIds = collectSlackDirectShareChannelIds(params.file);
  const sharedIds = collectSlackSharedChannelIds(params.file);
  const hasChannelEvidence = directIds.size > 0 || sharedIds.size > 0;
  const inChannel = directIds.has(channelId) || sharedIds.has(channelId);
  if (hasChannelEvidence && !inChannel) {
    return true;
  }

  if (!threadId) {
    return false;
  }
  const threadShares = collectSlackThreadShares(params.file, channelId);
  if (threadShares.length === 0) {
    return false;
  }
  const threadEvidence = threadShares.filter((entry) => entry.threadTs || entry.ts);
  if (threadEvidence.length === 0) {
    return false;
  }
  return !threadEvidence.some((entry) => entry.threadTs === threadId || entry.ts === threadId);
}

/**
 * Downloads a Slack file by ID and saves it to the local media store.
 * Fetches a fresh download URL via files.info to avoid using stale private URLs.
 * Returns null when the file cannot be found or downloaded.
 */
export async function downloadSlackFile(
  fileId: string,
  opts: SlackActionClientOpts & { maxBytes: number; channelId?: string; threadId?: string },
): Promise<SlackMediaResult | null> {
  const token = resolveToken(opts.token, opts.accountId, opts.cfg);
  const client = await getClient(opts);

  // Fetch fresh file metadata (includes a current url_private_download).
  const info = await client.files.info({ file: fileId });
  const file = info.file as SlackFileInfoSummary | undefined;

  if (!file?.url_private_download && !file?.url_private) {
    return null;
  }
  if (hasSlackScopeMismatch({ file, channelId: opts.channelId, threadId: opts.threadId })) {
    return null;
  }

  const results = await resolveSlackMedia({
    files: [
      {
        id: file.id,
        name: file.name,
        mimetype: file.mimetype,
        url_private: file.url_private,
        url_private_download: file.url_private_download,
      },
    ],
    token,
    maxBytes: opts.maxBytes,
  });

  return results?.[0] ?? null;
}
