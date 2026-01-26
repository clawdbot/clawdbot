import { type FilesUploadV2Arguments, type WebClient } from "@slack/web-api";

import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { loadWebMedia } from "../web/media.js";
import type { SlackTokenSource } from "./accounts.js";
import { resolveSlackAccount } from "./accounts.js";
import { createSlackWebClient } from "./client.js";
import { markdownToSlackMrkdwnChunks } from "./format.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { parseSlackTarget } from "./targets.js";
import { resolveSlackBotToken } from "./token.js";

const SLACK_TEXT_LIMIT = 4000;

type SlackRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

type SlackSendOpts = {
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  client?: WebClient;
  threadTs?: string;
};

export type SlackSendResult = {
  messageId: string;
  channelId: string;
};

function resolveToken(params: {
  explicit?: string;
  accountId: string;
  fallbackToken?: string;
  fallbackSource?: SlackTokenSource;
}) {
  const explicit = resolveSlackBotToken(params.explicit);
  if (explicit) return explicit;
  const fallback = resolveSlackBotToken(params.fallbackToken);
  if (!fallback) {
    logVerbose(
      `slack send: missing bot token for account=${params.accountId} explicit=${Boolean(
        params.explicit,
      )} source=${params.fallbackSource ?? "unknown"}`,
    );
    throw new Error(
      `Slack bot token missing for account "${params.accountId}" (set channels.slack.accounts.${params.accountId}.botToken or SLACK_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

function parseRecipient(raw: string): SlackRecipient {
  const target = parseSlackTarget(raw);
  if (!target) {
    throw new Error("Recipient is required for Slack sends");
  }
  return { kind: target.kind, id: target.id };
}

async function resolveChannelId(
  client: WebClient,
  recipient: SlackRecipient,
): Promise<{ channelId: string; isDm?: boolean }> {
  if (recipient.kind === "channel") {
    return { channelId: recipient.id };
  }
  const response = await client.conversations.open({ users: recipient.id });
  const channelId = response.channel?.id;
  if (!channelId) {
    throw new Error("Failed to open Slack DM channel");
  }
  return { channelId, isDm: true };
}

async function uploadSlackFile(params: {
  client: WebClient;
  channelId: string;
  mediaUrl: string;
  caption?: string;
  threadTs?: string;
  maxBytes?: number;
}): Promise<string> {
  const {
    buffer,
    contentType: _contentType,
    fileName,
  } = await loadWebMedia(params.mediaUrl, params.maxBytes);
  const basePayload = {
    channel_id: params.channelId,
    file: buffer,
    filename: fileName,
    ...(params.caption ? { initial_comment: params.caption } : {}),
    // Note: filetype is deprecated in files.uploadV2, Slack auto-detects from file content
  };
  const payload: FilesUploadV2Arguments = params.threadTs
    ? { ...basePayload, thread_ts: params.threadTs }
    : basePayload;
  const response = await params.client.files.uploadV2(payload);
  const parsed = response as {
    files?: Array<{ id?: string; name?: string }>;
    file?: { id?: string; name?: string };
  };
  const fileId =
    parsed.files?.[0]?.id ??
    parsed.file?.id ??
    parsed.files?.[0]?.name ??
    parsed.file?.name ??
    "unknown";
  return fileId;
}

export async function sendMessageSlack(
  to: string,
  message: string,
  opts: SlackSendOpts = {},
): Promise<SlackSendResult> {
  const trimmedMessage = message?.trim() ?? "";
  if (!trimmedMessage && !opts.mediaUrl) {
    throw new Error("Slack send requires text or media");
  }
  const cfg = loadConfig();
  const account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken({
    explicit: opts.token,
    accountId: account.accountId,
    fallbackToken: account.botToken,
    fallbackSource: account.botTokenSource,
  });
  const client = opts.client ?? createSlackWebClient(token);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(client, recipient);
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId);
  const chunkLimit = Math.min(textLimit, SLACK_TEXT_LIMIT);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "slack",
    accountId: account.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "slack", account.accountId);
  const markdownChunks =
    chunkMode === "newline"
      ? chunkMarkdownTextWithMode(trimmedMessage, chunkLimit, chunkMode)
      : [trimmedMessage];
  const chunks = markdownChunks.flatMap((markdown) =>
    markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode }),
  );
  if (!chunks.length && trimmedMessage) chunks.push(trimmedMessage);
  const mediaMaxBytes =
    typeof account.config.mediaMaxMb === "number"
      ? account.config.mediaMaxMb * 1024 * 1024
      : undefined;

  let lastMessageId = "";
  if (opts.mediaUrl) {
    const [firstChunk, ...rest] = chunks;
    lastMessageId = await uploadSlackFile({
      client,
      channelId,
      mediaUrl: opts.mediaUrl,
      caption: firstChunk,
      threadTs: opts.threadTs,
      maxBytes: mediaMaxBytes,
    });
    for (const chunk of rest) {
      const response = await client.chat.postMessage({
        channel: channelId,
        text: chunk,
        thread_ts: opts.threadTs,
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  } else {
    for (const chunk of chunks.length ? chunks : [""]) {
      const response = await client.chat.postMessage({
        channel: channelId,
        text: chunk,
        thread_ts: opts.threadTs,
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  }

  return {
    messageId: lastMessageId || "unknown",
    channelId,
  };
}
