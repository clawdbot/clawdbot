import type { RequestClient } from "@buape/carbon";
import { resolveAgentAvatar } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { MarkdownTableMode, ReplyToMode } from "openclaw/plugin-sdk/config-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import {
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
  type RetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { convertMarkdownTables, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordAccount } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { isLikelyDiscordVideoMedia } from "../media-detection.js";
import { createDiscordRetryRunner } from "../retry.js";
import { sendMessageDiscord, sendVoiceMessageDiscord, sendWebhookMessageDiscord } from "../send.js";
import { sendDiscordText } from "../send.shared.js";

export type DiscordThreadBindingLookupRecord = {
  accountId: string;
  threadId: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
};

export type DiscordThreadBindingLookup = {
  listBySessionKey: (targetSessionKey: string) => DiscordThreadBindingLookupRecord[];
  touchThread?: (params: { threadId: string; at?: number; persist?: boolean }) => unknown;
};

type ResolvedRetryConfig = Required<RetryConfig>;

const DISCORD_DELIVERY_RETRY_DEFAULTS: ResolvedRetryConfig = {
  attempts: 3,
  minDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0,
};

function isRetryableDiscordError(err: unknown): boolean {
  const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  return status === 429 || (status !== undefined && status >= 500);
}

function getDiscordRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  if (
    "retryAfter" in err &&
    typeof err.retryAfter === "number" &&
    Number.isFinite(err.retryAfter)
  ) {
    return err.retryAfter * 1000;
  }
  const retryAfterRaw = (err as { headers?: Record<string, string> }).headers?.["retry-after"];
  if (!retryAfterRaw) {
    return undefined;
  }
  const retryAfterMs = Number(retryAfterRaw) * 1000;
  return Number.isFinite(retryAfterMs) ? retryAfterMs : undefined;
}

function resolveDeliveryRetryConfig(retry?: RetryConfig): ResolvedRetryConfig {
  return resolveRetryConfig(DISCORD_DELIVERY_RETRY_DEFAULTS, retry);
}

async function sendWithRetry(
  fn: () => Promise<unknown>,
  retryConfig: ResolvedRetryConfig,
): Promise<void> {
  await retryAsync(fn, {
    ...retryConfig,
    shouldRetry: (err) => isRetryableDiscordError(err),
    retryAfterMs: getDiscordRetryAfterMs,
  });
}

async function sendDiscordMediaOnly(params: {
  target: string;
  cfg: OpenClawConfig;
  token: string;
  rest?: RequestClient;
  mediaUrl: string;
  accountId?: string;
  mediaLocalRoots?: readonly string[];
  replyTo?: string;
  retryConfig: ResolvedRetryConfig;
}): Promise<void> {
  await sendWithRetry(
    () =>
      sendMessageDiscord(params.target, "", {
        cfg: params.cfg,
        token: params.token,
        rest: params.rest,
        mediaUrl: params.mediaUrl,
        accountId: params.accountId,
        mediaLocalRoots: params.mediaLocalRoots,
        replyTo: params.replyTo,
      }),
    params.retryConfig,
  );
}

async function sendDiscordMediaBatch(params: {
  target: string;
  cfg: OpenClawConfig;
  token: string;
  rest?: RequestClient;
  mediaUrls: string[];
  accountId?: string;
  mediaLocalRoots?: readonly string[];
  replyTo: () => string | undefined;
  retryConfig: ResolvedRetryConfig;
}): Promise<void> {
  await sendMediaWithLeadingCaption({
    mediaUrls: params.mediaUrls,
    caption: "",
    send: async ({ mediaUrl }) => {
      await sendDiscordMediaOnly({
        target: params.target,
        cfg: params.cfg,
        token: params.token,
        rest: params.rest,
        mediaUrl,
        accountId: params.accountId,
        mediaLocalRoots: params.mediaLocalRoots,
        replyTo: params.replyTo(),
        retryConfig: params.retryConfig,
      });
    },
  });
}

async function sendDiscordPayloadText(params: {
  cfg: OpenClawConfig;
  target: string;
  text: string;
  token: string;
  rest?: RequestClient;
  accountId?: string;
  textLimit?: number;
  maxLinesPerMessage?: number;
  binding?: DiscordThreadBindingLookupRecord;
  chunkMode?: ChunkMode;
  username?: string;
  avatarUrl?: string;
  channelId?: string;
  request?: RetryRunner;
  retryConfig: ResolvedRetryConfig;
  resolveReplyTo: () => string | undefined;
}): Promise<void> {
  const mode = params.chunkMode ?? "length";
  const chunkLimit = Math.min(params.textLimit ?? 2000, 2000);
  const chunks = resolveTextChunksWithFallback(
    params.text,
    chunkDiscordTextWithMode(params.text, {
      maxChars: chunkLimit,
      maxLines: params.maxLinesPerMessage,
      chunkMode: mode,
    }),
  );
  for (const chunk of chunks) {
    if (!chunk.trim()) {
      continue;
    }
    await sendDiscordChunkWithFallback({
      cfg: params.cfg,
      target: params.target,
      text: chunk,
      token: params.token,
      rest: params.rest,
      accountId: params.accountId,
      maxLinesPerMessage: params.maxLinesPerMessage,
      replyTo: params.resolveReplyTo(),
      binding: params.binding,
      chunkMode: params.chunkMode,
      username: params.username,
      avatarUrl: params.avatarUrl,
      channelId: params.channelId,
      request: params.request,
      retryConfig: params.retryConfig,
    });
  }
}

function resolveTargetChannelId(target: string): string | undefined {
  if (!target.startsWith("channel:")) {
    return undefined;
  }
  const channelId = target.slice("channel:".length).trim();
  return channelId || undefined;
}

function resolveBoundThreadBinding(params: {
  threadBindings?: DiscordThreadBindingLookup;
  sessionKey?: string;
  target: string;
}): DiscordThreadBindingLookupRecord | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!params.threadBindings || !sessionKey) {
    return undefined;
  }
  const bindings = params.threadBindings.listBySessionKey(sessionKey);
  if (bindings.length === 0) {
    return undefined;
  }
  const targetChannelId = resolveTargetChannelId(params.target);
  if (!targetChannelId) {
    return undefined;
  }
  return bindings.find((entry) => entry.threadId === targetChannelId);
}

function createPayloadReplyToResolver(params: {
  payload: ReplyPayload;
  replyToMode: ReplyToMode;
  resolveFallbackReplyTo: () => string | undefined;
}): () => string | undefined {
  const payloadReplyTo = normalizeOptionalString(params.payload.replyToId);
  const allowExplicitReplyWhenOff = Boolean(
    payloadReplyTo && (params.payload.replyToTag || params.payload.replyToCurrent),
  );

  if (!payloadReplyTo || (params.replyToMode === "off" && !allowExplicitReplyWhenOff)) {
    return params.resolveFallbackReplyTo;
  }

  let payloadReplyUsed = false;
  return () => {
    if (params.replyToMode === "all") {
      return payloadReplyTo;
    }
    if (payloadReplyUsed) {
      return undefined;
    }
    payloadReplyUsed = true;
    return payloadReplyTo;
  };
}

function resolveBindingPersona(
  cfg: OpenClawConfig,
  binding: DiscordThreadBindingLookupRecord | undefined,
): {
  username?: string;
  avatarUrl?: string;
} {
  if (!binding) {
    return {};
  }
  const baseLabel = binding.label?.trim() || binding.agentId;
  const username = (`🤖 ${baseLabel}`.trim() || "🤖 agent").slice(0, 80);

  let avatarUrl: string | undefined;
  try {
    const avatar = resolveAgentAvatar(cfg, binding.agentId);
    if (avatar.kind === "remote") {
      avatarUrl = avatar.url;
    }
  } catch {
    avatarUrl = undefined;
  }
  return { username, avatarUrl };
}

async function sendDiscordChunkWithFallback(params: {
  cfg: OpenClawConfig;
  target: string;
  text: string;
  token: string;
  accountId?: string;
  maxLinesPerMessage?: number;
  rest?: RequestClient;
  replyTo?: string;
  binding?: DiscordThreadBindingLookupRecord;
  chunkMode?: ChunkMode;
  username?: string;
  avatarUrl?: string;
  /** Pre-resolved channel ID to bypass redundant resolution per chunk. */
  channelId?: string;
  /** Pre-created retry runner to avoid creating one per chunk. */
  request?: RetryRunner;
  /** Pre-resolved retry config (account-level). */
  retryConfig: ResolvedRetryConfig;
}) {
  if (!params.text.trim()) {
    return;
  }
  const text = params.text;
  const binding = params.binding;
  if (binding?.webhookId && binding?.webhookToken) {
    try {
      await sendWebhookMessageDiscord(text, {
        cfg: params.cfg,
        webhookId: binding.webhookId,
        webhookToken: binding.webhookToken,
        accountId: binding.accountId,
        threadId: binding.threadId,
        replyTo: params.replyTo,
        username: params.username,
        avatarUrl: params.avatarUrl,
      });
      return;
    } catch {
      // Fall through to the standard bot sender path.
    }
  }
  // When channelId and request are pre-resolved, send directly via sendDiscordText
  // to avoid per-chunk overhead (channel-type GET, re-chunking, client creation)
  // that can cause ordering issues under queue contention or rate limiting.
  if (params.channelId && params.request && params.rest) {
    const { channelId, request, rest } = params;
    await sendWithRetry(
      () =>
        sendDiscordText(
          rest,
          channelId,
          text,
          params.replyTo,
          request,
          params.maxLinesPerMessage,
          undefined,
          undefined,
          params.chunkMode,
        ),
      params.retryConfig,
    );
    return;
  }
  await sendWithRetry(
    () =>
      sendMessageDiscord(params.target, text, {
        cfg: params.cfg,
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo: params.replyTo,
      }),
    params.retryConfig,
  );
}

export async function deliverDiscordReply(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToId?: string;
  replyToMode?: ReplyToMode;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  sessionKey?: string;
  threadBindings?: DiscordThreadBindingLookup;
  mediaLocalRoots?: readonly string[];
}) {
  const replyTo = normalizeOptionalString(params.replyToId);
  const replyToMode = params.replyToMode ?? "all";
  const replyOnce = isSingleUseReplyToMode(replyToMode);
  let replyUsed = false;
  const resolveReplyTo = () => {
    if (!replyTo) {
      return undefined;
    }
    if (!replyOnce) {
      return replyTo;
    }
    if (replyUsed) {
      return undefined;
    }
    replyUsed = true;
    return replyTo;
  };
  const binding = resolveBoundThreadBinding({
    threadBindings: params.threadBindings,
    sessionKey: params.sessionKey,
    target: params.target,
  });
  const persona = resolveBindingPersona(params.cfg, binding);
  // Pre-resolve channel ID and retry runner once to avoid per-chunk overhead.
  // This eliminates redundant channel-type GET requests and client creation that
  // can cause ordering issues when multiple chunks share the RequestClient queue.
  const channelId = resolveTargetChannelId(params.target);
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const retryConfig = resolveDeliveryRetryConfig(account.config.retry);
  const request: RetryRunner | undefined = channelId
    ? createDiscordRetryRunner({ configRetry: account.config.retry })
    : undefined;
  let deliveredAny = false;
  for (const payload of params.replies) {
    const resolvePayloadReplyTo = createPayloadReplyToResolver({
      payload,
      replyToMode,
      resolveFallbackReplyTo: resolveReplyTo,
    });
    const tableMode = params.tableMode ?? "code";
    const reply = resolveSendableOutboundReplyParts(payload, {
      text: convertMarkdownTables(payload.text ?? "", tableMode),
    });
    if (!reply.hasContent) {
      continue;
    }
    const sendReplyText = async () =>
      sendDiscordPayloadText({
        cfg: params.cfg,
        target: params.target,
        text: reply.text,
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        textLimit: params.textLimit,
        maxLinesPerMessage: params.maxLinesPerMessage,
        resolveReplyTo: resolvePayloadReplyTo,
        binding,
        chunkMode: params.chunkMode,
        username: persona.username,
        avatarUrl: persona.avatarUrl,
        channelId,
        request,
        retryConfig,
      });
    const sendReplyMediaBatch = async (mediaUrls: string[]) =>
      sendDiscordMediaBatch({
        target: params.target,
        cfg: params.cfg,
        token: params.token,
        rest: params.rest,
        mediaUrls,
        accountId: params.accountId,
        mediaLocalRoots: params.mediaLocalRoots,
        replyTo: resolvePayloadReplyTo,
        retryConfig,
      });
    if (!reply.hasMedia) {
      await sendReplyText();
      if (reply.text.trim()) {
        deliveredAny = true;
      }
      continue;
    }

    const firstMedia = reply.mediaUrls[0];
    if (!firstMedia) {
      continue;
    }
    // Voice message path: audioAsVoice flag routes through sendVoiceMessageDiscord.
    if (payload.audioAsVoice) {
      const replyTo = resolvePayloadReplyTo();
      await sendVoiceMessageDiscord(params.target, firstMedia, {
        cfg: params.cfg,
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo,
      });
      deliveredAny = true;
      // Voice messages cannot include text; send remaining text separately if present.
      await sendReplyText();
      // Additional media items are sent as regular attachments (voice is single-file only).
      await sendReplyMediaBatch(reply.mediaUrls.slice(1));
      continue;
    }

    const shouldSplitVideoMediaReply =
      reply.text.trim().length > 0 &&
      reply.mediaUrls.some((mediaUrl) => isLikelyDiscordVideoMedia(mediaUrl));
    if (shouldSplitVideoMediaReply) {
      await sendReplyText();
      await sendReplyMediaBatch(reply.mediaUrls);
      deliveredAny = true;
      continue;
    }

    await sendMediaWithLeadingCaption({
      mediaUrls: reply.mediaUrls,
      caption: reply.text,
      send: async ({ mediaUrl, caption }) => {
        const replyTo = resolvePayloadReplyTo();
        await sendWithRetry(
          () =>
            sendMessageDiscord(params.target, caption ?? "", {
              cfg: params.cfg,
              token: params.token,
              rest: params.rest,
              mediaUrl,
              accountId: params.accountId,
              mediaLocalRoots: params.mediaLocalRoots,
              replyTo,
            }),
          retryConfig,
        );
      },
    });
    deliveredAny = true;
  }

  if (binding && deliveredAny) {
    params.threadBindings?.touchThread?.({ threadId: binding.threadId });
  }
}
