import {
  chunkMarkdownText,
  isSilentReplyText,
  type MSTeamsReplyStyle,
  type ReplyPayload,
  SILENT_REPLY_TOKEN,
} from "clawdbot/plugin-sdk";
import type { StoredConversationReference } from "./conversation-store.js";
import { classifyMSTeamsSendError } from "./errors.js";

type SendContext = {
  sendActivity: (textOrActivity: string | object) => Promise<unknown>;
};

export type MSTeamsConversationReference = {
  activityId?: string;
  user?: { id?: string; name?: string; aadObjectId?: string };
  agent?: { id?: string; name?: string; aadObjectId?: string } | null;
  conversation: { id: string; conversationType?: string; tenantId?: string };
  channelId: string;
  serviceUrl?: string;
  locale?: string;
};

export type MSTeamsAdapter = {
  continueConversation: (
    appId: string,
    reference: MSTeamsConversationReference,
    logic: (context: SendContext) => Promise<void>,
  ) => Promise<void>;
  process: (
    req: unknown,
    res: unknown,
    logic: (context: unknown) => Promise<void>,
  ) => Promise<void>;
};

export type MSTeamsReplyRenderOptions = {
  textChunkLimit: number;
  chunkText?: boolean;
  mediaMode?: "split" | "inline";
};

export type MSTeamsSendRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type MSTeamsSendRetryEvent = {
  messageIndex: number;
  messageCount: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  classification: ReturnType<typeof classifyMSTeamsSendError>;
};

function normalizeConversationId(rawId: string): string {
  return rawId.split(";")[0] ?? rawId;
}

export function buildConversationReference(
  ref: StoredConversationReference,
): MSTeamsConversationReference {
  const conversationId = ref.conversation?.id?.trim();
  if (!conversationId) {
    throw new Error("Invalid stored reference: missing conversation.id");
  }
  const agent = ref.agent ?? ref.bot ?? undefined;
  if (agent == null || !agent.id) {
    throw new Error("Invalid stored reference: missing agent.id");
  }
  const user = ref.user;
  if (!user?.id) {
    throw new Error("Invalid stored reference: missing user.id");
  }
  return {
    activityId: ref.activityId,
    user,
    agent,
    conversation: {
      id: normalizeConversationId(conversationId),
      conversationType: ref.conversation?.conversationType,
      tenantId: ref.conversation?.tenantId,
    },
    channelId: ref.channelId ?? "msteams",
    serviceUrl: ref.serviceUrl,
    locale: ref.locale,
  };
}

function extractMessageId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  if (!("id" in response)) return null;
  const { id } = response as { id?: unknown };
  if (typeof id !== "string" || !id) return null;
  return id;
}

function pushTextMessages(
  out: string[],
  text: string,
  opts: {
    chunkText: boolean;
    chunkLimit: number;
  },
) {
  if (!text) return;
  if (opts.chunkText) {
    for (const chunk of chunkMarkdownText(text, opts.chunkLimit)) {
      const trimmed = chunk.trim();
      if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) continue;
      out.push(trimmed);
    }
    return;
  }

  const trimmed = text.trim();
  if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) return;
  out.push(trimmed);
}

function clampMs(value: number, maxMs: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, maxMs);
}

async function sleep(ms: number): Promise<void> {
  const delay = Math.max(0, ms);
  if (delay === 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delay);
  });
}

function resolveRetryOptions(
  retry: false | MSTeamsSendRetryOptions | undefined,
): Required<MSTeamsSendRetryOptions> & { enabled: boolean } {
  if (!retry) {
    return { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };
  }
  return {
    enabled: true,
    maxAttempts: Math.max(1, retry?.maxAttempts ?? 3),
    baseDelayMs: Math.max(0, retry?.baseDelayMs ?? 250),
    maxDelayMs: Math.max(0, retry?.maxDelayMs ?? 10_000),
  };
}

function computeRetryDelayMs(
  attempt: number,
  classification: ReturnType<typeof classifyMSTeamsSendError>,
  opts: Required<MSTeamsSendRetryOptions>,
): number {
  if (classification.retryAfterMs != null) {
    return clampMs(classification.retryAfterMs, opts.maxDelayMs);
  }
  const exponential = opts.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return clampMs(exponential, opts.maxDelayMs);
}

function shouldRetry(classification: ReturnType<typeof classifyMSTeamsSendError>): boolean {
  return classification.kind === "throttled" || classification.kind === "transient";
}

export function renderReplyPayloadsToMessages(
  replies: ReplyPayload[],
  options: MSTeamsReplyRenderOptions,
): string[] {
  const out: string[] = [];
  const chunkLimit = Math.min(options.textChunkLimit, 4000);
  const chunkText = options.chunkText !== false;
  const mediaMode = options.mediaMode ?? "split";

  for (const payload of replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";

    if (!text && mediaList.length === 0) continue;

    if (mediaList.length === 0) {
      pushTextMessages(out, text, { chunkText, chunkLimit });
      continue;
    }

    if (mediaMode === "inline") {
      const combined = text ? `${text}\n\n${mediaList.join("\n")}` : mediaList.join("\n");
      pushTextMessages(out, combined, { chunkText, chunkLimit });
      continue;
    }

    // mediaMode === "split"
    pushTextMessages(out, text, { chunkText, chunkLimit });
    for (const mediaUrl of mediaList) {
      if (!mediaUrl) continue;
      out.push(mediaUrl);
    }
  }

  return out;
}

export async function sendMSTeamsMessages(params: {
  replyStyle: MSTeamsReplyStyle;
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  context?: SendContext;
  messages: string[];
  retry?: false | MSTeamsSendRetryOptions;
  onRetry?: (event: MSTeamsSendRetryEvent) => void;
}): Promise<string[]> {
  const messages = params.messages
    .map((m) => (typeof m === "string" ? m : String(m)))
    .filter((m) => m.trim().length > 0);
  if (messages.length === 0) return [];

  const retryOptions = resolveRetryOptions(params.retry);

  const sendWithRetry = async (
    sendOnce: () => Promise<unknown>,
    meta: { messageIndex: number; messageCount: number },
  ): Promise<unknown> => {
    if (!retryOptions.enabled) return await sendOnce();

    let attempt = 1;
    while (true) {
      try {
        return await sendOnce();
      } catch (err) {
        const classification = classifyMSTeamsSendError(err);
        const canRetry = attempt < retryOptions.maxAttempts && shouldRetry(classification);
        if (!canRetry) throw err;

        const delayMs = computeRetryDelayMs(attempt, classification, retryOptions);
        const nextAttempt = attempt + 1;
        params.onRetry?.({
          messageIndex: meta.messageIndex,
          messageCount: meta.messageCount,
          nextAttempt,
          maxAttempts: retryOptions.maxAttempts,
          delayMs,
          classification,
        });

        await sleep(delayMs);
        attempt = nextAttempt;
      }
    }
  };

  if (params.replyStyle === "thread") {
    const ctx = params.context;
    if (!ctx) {
      throw new Error("Missing context for replyStyle=thread");
    }
    const messageIds: string[] = [];
    for (const [idx, message] of messages.entries()) {
      const response = await sendWithRetry(
        async () =>
          await ctx.sendActivity({
            type: "message",
            text: message,
          }),
        { messageIndex: idx, messageCount: messages.length },
      );
      messageIds.push(extractMessageId(response) ?? "unknown");
    }
    return messageIds;
  }

  const baseRef = buildConversationReference(params.conversationRef);
  const proactiveRef: MSTeamsConversationReference = {
    ...baseRef,
    activityId: undefined,
  };

  const messageIds: string[] = [];
  await params.adapter.continueConversation(params.appId, proactiveRef, async (ctx) => {
    for (const [idx, message] of messages.entries()) {
      const response = await sendWithRetry(
        async () =>
          await ctx.sendActivity({
            type: "message",
            text: message,
          }),
        { messageIndex: idx, messageCount: messages.length },
      );
      messageIds.push(extractMessageId(response) ?? "unknown");
    }
  });
  return messageIds;
}
