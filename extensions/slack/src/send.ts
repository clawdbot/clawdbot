import { type Block, type KnownBlock, type WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  chunkMarkdownTextWithMode,
  isSilentReplyText,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { resolveTextChunksWithFallback } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { SlackTokenSource } from "./accounts.js";
import { resolveSlackAccount } from "./accounts.js";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
import { validateSlackBlocksArray } from "./blocks-input.js";
import { createSlackTokenCacheKey, getSlackWriteClient } from "./client.js";
import { markdownToSlackMrkdwnChunks } from "./format.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { loadOutboundMediaFromUrl } from "./runtime-api.js";
import { recordSlackThreadParticipation } from "./sent-thread-cache.js";
import { parseSlackTarget } from "./targets.js";
import { normalizeSlackThreadTsCandidate } from "./thread-ts.js";
import { resolveSlackBotToken } from "./token.js";
import { truncateSlackText } from "./truncate.js";
const SLACK_UPLOAD_SSRF_POLICY = {
  allowedHostnames: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  allowRfc2544BenchmarkRange: true,
};
const SLACK_DM_CHANNEL_CACHE_MAX = 1024;
const SLACK_DNS_RETRY_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "UND_ERR_DNS_RESOLVE_FAILED"]);
const SLACK_DNS_RETRY_ATTEMPTS = 2;
const SLACK_DNS_RETRY_BASE_DELAY_MS = 250;
const slackDmChannelCache = new Map<string, string>();
const slackSendQueues = new Map<string, Promise<void>>();

type SlackRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

export type SlackSendIdentity = {
  username?: string;
  iconUrl?: string;
  iconEmoji?: string;
};

type SlackSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  uploadFileName?: string;
  uploadTitle?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  client?: WebClient;
  threadTs?: string;
  identity?: SlackSendIdentity;
  blocks?: (Block | KnownBlock)[];
};

type SlackWebApiErrorData = {
  error?: unknown;
  needed?: unknown;
  response_metadata?: {
    scopes?: unknown;
    acceptedScopes?: unknown;
  };
};

type SlackWebApiError = Error & {
  data?: SlackWebApiErrorData;
};

function hasCustomIdentity(identity?: SlackSendIdentity): boolean {
  return Boolean(identity?.username || identity?.iconUrl || identity?.iconEmoji);
}

function normalizeSlackApiString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSlackScopeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((scope) => {
    const normalized = normalizeSlackApiString(scope);
    return normalized ? [normalized] : [];
  });
}

function getSlackWebApiErrorData(err: unknown): SlackWebApiErrorData | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  const data = (err as SlackWebApiError).data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  return data;
}

function formatSlackWebApiErrorMessage(err: unknown): string | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  const data = getSlackWebApiErrorData(err);
  const code = normalizeSlackApiString(data?.error);
  if (!code) {
    return undefined;
  }
  const details: string[] = [];
  const needed = normalizeSlackApiString(data?.needed);
  if (needed) {
    details.push(`needed: ${needed}`);
  }
  const scopes = normalizeSlackScopeList(data?.response_metadata?.scopes);
  if (scopes.length) {
    details.push(`granted: ${scopes.join(", ")}`);
  }
  const acceptedScopes = normalizeSlackScopeList(data?.response_metadata?.acceptedScopes);
  if (acceptedScopes.length) {
    details.push(`accepted: ${acceptedScopes.join(", ")}`);
  }
  return `${err.message || `An API error occurred: ${code}`}${
    details.length ? ` (${details.join("; ")})` : ""
  }`;
}

function enrichSlackWebApiError(err: unknown): unknown {
  const message = formatSlackWebApiErrorMessage(err);
  if (!message || !(err instanceof Error) || message === err.message) {
    return err;
  }
  return new Error(message);
}

function readSlackRequestErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

function readSlackRequestErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return typeof value === "string" ? value : "";
}

function hasSlackDnsRequestSignal(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    const code = readSlackRequestErrorCode(current);
    if (code && SLACK_DNS_RETRY_CODES.has(code)) {
      return true;
    }
    const message = readSlackRequestErrorMessage(current);
    if (/\b(EAI_AGAIN|ENOTFOUND|UND_ERR_DNS_RESOLVE_FAILED)\b/i.test(message)) {
      return true;
    }
    current =
      (current as { original?: unknown; cause?: unknown }).original ??
      (current as { cause?: unknown }).cause;
  }
  return false;
}

function delaySlackDnsRetry(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, SLACK_DNS_RETRY_BASE_DELAY_MS * Math.max(1, attempt)),
  );
}

async function withSlackDnsRequestRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= SLACK_DNS_RETRY_ATTEMPTS || !hasSlackDnsRequestSignal(err)) {
        throw err;
      }
      logVerbose(
        `slack send: retrying ${operation} after transient DNS request error (${attempt + 1}/${SLACK_DNS_RETRY_ATTEMPTS})`,
      );
      await delaySlackDnsRetry(attempt + 1);
    }
  }
}

function isSlackCustomizeScopeError(err: unknown): boolean {
  const data = getSlackWebApiErrorData(err);
  const code = normalizeLowercaseStringOrEmpty(normalizeSlackApiString(data?.error));
  if (code !== "missing_scope") {
    return false;
  }
  const needed = normalizeLowercaseStringOrEmpty(normalizeSlackApiString(data?.needed));
  if (needed?.includes("chat:write.customize")) {
    return true;
  }
  const scopes = [
    ...normalizeSlackScopeList(data?.response_metadata?.scopes),
    ...normalizeSlackScopeList(data?.response_metadata?.acceptedScopes),
  ].map((scope) => normalizeLowercaseStringOrEmpty(scope));
  return scopes.includes("chat:write.customize");
}

async function postSlackMessageBestEffort(params: {
  client: WebClient;
  channelId: string;
  text: string;
  threadTs?: string;
  identity?: SlackSendIdentity;
  blocks?: (Block | KnownBlock)[];
}) {
  const basePayload = {
    channel: params.channelId,
    text: params.text,
    thread_ts: params.threadTs,
    ...(params.blocks?.length ? { blocks: params.blocks } : {}),
  };
  const postChatMessage = params.client.chat.postMessage.bind(params.client.chat);
  try {
    // Slack Web API types model icon_url and icon_emoji as mutually exclusive.
    // Build payloads in explicit branches so TS and runtime stay aligned.
    const identity = params.identity;
    if (identity?.iconUrl) {
      return await withSlackDnsRequestRetry("chat.postMessage", () =>
        postChatMessage({
          ...basePayload,
          ...(identity.username ? { username: identity.username } : {}),
          icon_url: identity.iconUrl,
        }),
      );
    }
    if (identity?.iconEmoji) {
      return await withSlackDnsRequestRetry("chat.postMessage", () =>
        postChatMessage({
          ...basePayload,
          ...(identity.username ? { username: identity.username } : {}),
          icon_emoji: identity.iconEmoji,
        }),
      );
    }
    return await withSlackDnsRequestRetry("chat.postMessage", () =>
      postChatMessage({
        ...basePayload,
        ...(identity?.username ? { username: identity.username } : {}),
      }),
    );
  } catch (err) {
    if (!hasCustomIdentity(params.identity) || !isSlackCustomizeScopeError(err)) {
      throw err;
    }
    logVerbose("slack send: missing chat:write.customize, retrying without custom identity");
    return withSlackDnsRequestRetry("chat.postMessage", () => postChatMessage(basePayload));
  }
}

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
  if (explicit) {
    return explicit;
  }
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

function createSlackSendQueueKey(params: {
  accountId: string;
  token: string;
  recipient: SlackRecipient;
  threadTs?: string;
}): string {
  const isUserId = params.recipient.kind === "user" || /^U[A-Z0-9]+$/i.test(params.recipient.id);
  const recipientKey = `${isUserId ? "user" : params.recipient.kind}:${params.recipient.id}`;
  return `${params.accountId}:${createSlackTokenCacheKey(params.token)}:${recipientKey}:${
    params.threadTs ?? ""
  }`;
}

async function runQueuedSlackSend<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = slackSendQueues.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queuedCurrent = previous.catch(() => undefined).then(() => current);
  slackSendQueues.set(key, queuedCurrent);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (slackSendQueues.get(key) === queuedCurrent) {
      slackSendQueues.delete(key);
    }
  }
}

function createSlackDmCacheKey(params: {
  accountId?: string;
  token: string;
  recipientId: string;
}): string {
  return `${params.accountId ?? "default"}:${createSlackTokenCacheKey(params.token)}:${
    params.recipientId
  }`;
}

function setSlackDmChannelCache(key: string, channelId: string): void {
  if (slackDmChannelCache.has(key)) {
    slackDmChannelCache.delete(key);
  } else if (slackDmChannelCache.size >= SLACK_DM_CHANNEL_CACHE_MAX) {
    const oldest = slackDmChannelCache.keys().next().value;
    if (oldest) {
      slackDmChannelCache.delete(oldest);
    }
  }
  slackDmChannelCache.set(key, channelId);
}

function isSlackUserRecipient(recipient: SlackRecipient): boolean {
  return recipient.kind === "user" || /^U[A-Z0-9]+$/i.test(recipient.id);
}

function resolveDirectUserPostChannelId(params: {
  recipient: SlackRecipient;
  hasMedia: boolean;
  threadTs?: string;
}): string | undefined {
  if (!isSlackUserRecipient(params.recipient) || params.hasMedia || params.threadTs) {
    return undefined;
  }
  return params.recipient.id;
}

async function resolveChannelId(
  client: WebClient,
  recipient: SlackRecipient,
  params: { accountId?: string; token: string },
): Promise<{ channelId: string; isDm?: boolean; cacheHit?: boolean }> {
  // Bare Slack user IDs (U-prefix) may arrive with kind="channel" when the
  // target string had no explicit prefix (parseSlackTarget defaults bare IDs
  // to "channel"). chat.postMessage tolerates user IDs directly, but
  // files.uploadV2 → completeUploadExternal validates channel_id against
  // ^[CGDZ][A-Z0-9]{8,}$ and rejects U-prefixed IDs. Resolve user IDs via
  // conversations.open only for paths that require the concrete DM channel ID.
  if (!isSlackUserRecipient(recipient)) {
    return { channelId: recipient.id };
  }
  const cacheKey = createSlackDmCacheKey({
    accountId: params.accountId,
    token: params.token,
    recipientId: recipient.id,
  });
  const cachedChannelId = slackDmChannelCache.get(cacheKey);
  if (cachedChannelId) {
    return { channelId: cachedChannelId, isDm: true, cacheHit: true };
  }
  const response = await withSlackDnsRequestRetry("conversations.open", () =>
    client.conversations.open({ users: recipient.id }),
  );
  const channelId = response.channel?.id;
  if (!channelId) {
    throw new Error("Failed to open Slack DM channel");
  }
  setSlackDmChannelCache(cacheKey, channelId);
  return { channelId, isDm: true, cacheHit: false };
}

export function clearSlackDmChannelCache(): void {
  slackDmChannelCache.clear();
}

export function clearSlackSendQueuesForTest(): void {
  slackSendQueues.clear();
}

async function uploadSlackFile(params: {
  client: WebClient;
  channelId: string;
  mediaUrl: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  uploadFileName?: string;
  uploadTitle?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  caption?: string;
  threadTs?: string;
  maxBytes?: number;
}): Promise<string> {
  const { buffer, contentType, fileName } = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: params.maxBytes,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });
  const uploadFileName = params.uploadFileName ?? fileName ?? "upload";
  const uploadTitle = params.uploadTitle ?? uploadFileName;
  // Use the 3-step upload flow (getUploadURLExternal -> POST -> completeUploadExternal)
  // instead of files.uploadV2 which relies on the deprecated files.upload endpoint
  // and can fail with missing_scope even when files:write is granted.
  const uploadUrlResp = await withSlackDnsRequestRetry("files.getUploadURLExternal", () =>
    params.client.files.getUploadURLExternal({
      filename: uploadFileName,
      length: buffer.length,
    }),
  );
  if (!uploadUrlResp.ok || !uploadUrlResp.upload_url || !uploadUrlResp.file_id) {
    throw new Error(`Failed to get upload URL: ${uploadUrlResp.error ?? "unknown error"}`);
  }
  const uploadFileId = uploadUrlResp.file_id;

  // Upload the file content to the presigned URL
  const uploadBody = new Uint8Array(buffer) as BodyInit;
  const { response: uploadResp, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
      url: uploadUrlResp.upload_url,
      init: {
        method: "POST",
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
        body: uploadBody,
      },
      policy: SLACK_UPLOAD_SSRF_POLICY,
      auditContext: "slack-upload-file",
    }),
  );
  try {
    if (!uploadResp.ok) {
      throw new Error(`Failed to upload file: HTTP ${uploadResp.status}`);
    }
  } finally {
    await release();
  }

  // Complete the upload and share to channel/thread
  const completeResp = await withSlackDnsRequestRetry("files.completeUploadExternal", () =>
    params.client.files.completeUploadExternal({
      files: [{ id: uploadFileId, title: uploadTitle }],
      channel_id: params.channelId,
      ...(params.caption ? { initial_comment: params.caption } : {}),
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    }),
  );
  if (!completeResp.ok) {
    throw new Error(`Failed to complete upload: ${completeResp.error ?? "unknown error"}`);
  }

  return uploadFileId;
}

export async function sendMessageSlack(
  to: string,
  message: string,
  opts: SlackSendOpts,
): Promise<SlackSendResult> {
  const trimmedMessage = normalizeOptionalString(message) ?? "";
  if (isSilentReplyText(trimmedMessage) && !opts.mediaUrl && !opts.blocks) {
    logVerbose("slack send: suppressed NO_REPLY token before API call");
    return { messageId: "suppressed", channelId: "" };
  }
  const blocks = opts.blocks == null ? undefined : validateSlackBlocksArray(opts.blocks);
  if (!trimmedMessage && !opts.mediaUrl && !blocks) {
    throw new Error("Slack send requires text, blocks, or media");
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Slack send");
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
  const recipient = parseRecipient(to);
  const queueKey = createSlackSendQueueKey({
    accountId: account.accountId,
    token,
    recipient,
    threadTs: opts.threadTs,
  });
  const result = await runQueuedSlackSend(queueKey, () =>
    sendMessageSlackQueued({
      trimmedMessage,
      opts,
      cfg,
      account,
      token,
      recipient,
      blocks,
    }),
  );
  const threadTs = normalizeSlackThreadTsCandidate(opts.threadTs);
  if (threadTs && result.channelId && account.accountId) {
    recordSlackThreadParticipation(account.accountId, result.channelId, threadTs);
  }
  return result;
}

async function sendMessageSlackQueued(params: {
  trimmedMessage: string;
  opts: SlackSendOpts;
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveSlackAccount>;
  token: string;
  recipient: SlackRecipient;
  blocks?: (Block | KnownBlock)[];
}): Promise<SlackSendResult> {
  try {
    return await sendMessageSlackQueuedInner(params);
  } catch (err) {
    throw enrichSlackWebApiError(err);
  }
}

async function sendMessageSlackQueuedInner(params: {
  trimmedMessage: string;
  opts: SlackSendOpts;
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveSlackAccount>;
  token: string;
  recipient: SlackRecipient;
  blocks?: (Block | KnownBlock)[];
}): Promise<SlackSendResult> {
  const { opts, cfg, account, token, recipient, blocks, trimmedMessage } = params;
  const client = opts.client ?? getSlackWriteClient(token);
  const directUserPostChannelId = resolveDirectUserPostChannelId({
    recipient,
    hasMedia: Boolean(opts.mediaUrl),
    ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
  });
  const { channelId } = directUserPostChannelId
    ? { channelId: directUserPostChannelId }
    : await resolveChannelId(client, recipient, {
        accountId: account.accountId,
        token,
      });
  if (blocks) {
    if (opts.mediaUrl) {
      throw new Error("Slack send does not support blocks with mediaUrl");
    }
    const fallbackText = truncateSlackText(
      trimmedMessage || buildSlackBlocksFallbackText(blocks),
      SLACK_TEXT_LIMIT,
    );
    const response = await postSlackMessageBestEffort({
      client,
      channelId,
      text: fallbackText,
      threadTs: opts.threadTs,
      identity: opts.identity,
      blocks,
    });
    return {
      messageId: response.ts ?? "unknown",
      channelId,
    };
  }
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId, {
    fallbackLimit: SLACK_TEXT_LIMIT,
  });
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
  const resolvedChunks = resolveTextChunksWithFallback(trimmedMessage, chunks);
  const mediaMaxBytes =
    typeof account.config.mediaMaxMb === "number"
      ? account.config.mediaMaxMb * 1024 * 1024
      : undefined;

  let lastMessageId = "";
  if (opts.mediaUrl) {
    const [firstChunk, ...rest] = resolvedChunks;
    lastMessageId = await uploadSlackFile({
      client,
      channelId,
      mediaUrl: opts.mediaUrl,
      mediaAccess: opts.mediaAccess,
      uploadFileName: opts.uploadFileName,
      uploadTitle: opts.uploadTitle,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
      caption: firstChunk,
      threadTs: opts.threadTs,
      maxBytes: mediaMaxBytes,
    });
    for (const chunk of rest) {
      const response = await postSlackMessageBestEffort({
        client,
        channelId,
        text: chunk,
        threadTs: opts.threadTs,
        identity: opts.identity,
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  } else {
    for (const chunk of resolvedChunks.length ? resolvedChunks : [""]) {
      const response = await postSlackMessageBestEffort({
        client,
        channelId,
        text: chunk,
        threadTs: opts.threadTs,
        identity: opts.identity,
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  }

  return {
    messageId: lastMessageId || "unknown",
    channelId,
  };
}
