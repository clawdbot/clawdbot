import { WebClient } from "@slack/web-api";

import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { resolveSlackAccount } from "./accounts.js";
import { sendMessageSlack } from "./send.js";
import { resolveSlackBotToken } from "./token.js";

export type SlackActionClientOpts = {
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
};

export type SlackPin = {
  type?: string;
  message?: { ts?: string; text?: string };
  file?: { id?: string; name?: string };
};

function resolveToken(explicit?: string, accountId?: string) {
  const cfg = loadConfig();
  const account = resolveSlackAccount({ cfg, accountId });
  const token = resolveSlackBotToken(explicit ?? account.botToken ?? undefined);
  if (!token) {
    logVerbose(
      `slack actions: missing bot token for account=${account.accountId} explicit=${Boolean(
        explicit,
      )} source=${account.botTokenSource ?? "unknown"}`,
    );
    throw new Error(
      "SLACK_BOT_TOKEN or channels.slack.botToken is required for Slack actions",
    );
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

async function getClient(opts: SlackActionClientOpts = {}) {
  const token = resolveToken(opts.token, opts.accountId);
  return opts.client ?? new WebClient(token);
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
  const client = await getClient(opts);
  await client.reactions.add({
    channel: channelId,
    timestamp: messageId,
    name: normalizeEmoji(emoji),
  });
}

export async function removeSlackReaction(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: SlackActionClientOpts = {},
) {
  const client = await getClient(opts);
  await client.reactions.remove({
    channel: channelId,
    timestamp: messageId,
    name: normalizeEmoji(emoji),
  });
}

export async function removeOwnSlackReactions(
  channelId: string,
  messageId: string,
  opts: SlackActionClientOpts = {},
): Promise<string[]> {
  const client = await getClient(opts);
  const userId = await resolveBotUserId(client);
  const reactions = await listSlackReactions(channelId, messageId, { client });
  const toRemove = new Set<string>();
  for (const reaction of reactions ?? []) {
    const name = reaction?.name;
    if (!name) continue;
    const users = reaction?.users ?? [];
    if (users.includes(userId)) {
      toRemove.add(name);
    }
  }
  if (toRemove.size === 0) return [];
  await Promise.all(
    Array.from(toRemove, (name) =>
      client.reactions.remove({
        channel: channelId,
        timestamp: messageId,
        name,
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
  opts: SlackActionClientOpts & { mediaUrl?: string; threadTs?: string } = {},
) {
  return await sendMessageSlack(to, content, {
    accountId: opts.accountId,
    token: opts.token,
    mediaUrl: opts.mediaUrl,
    client: opts.client,
    threadTs: opts.threadTs,
  });
}

export async function editSlackMessage(
  channelId: string,
  messageId: string,
  content: string,
  opts: SlackActionClientOpts = {},
) {
  const client = await getClient(opts);
  await client.chat.update({
    channel: channelId,
    ts: messageId,
    text: content,
  });
}

export async function deleteSlackMessage(
  channelId: string,
  messageId: string,
  opts: SlackActionClientOpts = {},
) {
  const client = await getClient(opts);
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
  } = {},
): Promise<{ messages: SlackMessageSummary[]; hasMore: boolean }> {
  const client = await getClient(opts);
  const result = await client.conversations.history({
    channel: channelId,
    limit: opts.limit,
    latest: opts.before,
    oldest: opts.after,
  });
  return {
    messages: (result.messages ?? []) as SlackMessageSummary[],
    hasMore: Boolean(result.has_more),
  };
}

export async function getSlackMemberInfo(
  userId: string,
  opts: SlackActionClientOpts = {},
) {
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
  const client = await getClient(opts);
  await client.pins.add({ channel: channelId, timestamp: messageId });
}

export async function unpinSlackMessage(
  channelId: string,
  messageId: string,
  opts: SlackActionClientOpts = {},
) {
  const client = await getClient(opts);
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
