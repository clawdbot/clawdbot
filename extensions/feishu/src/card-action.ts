import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { decodeFeishuCardAction, buildFeishuCardActionTextFallback } from "./card-interaction.js";
import {
  createApprovalCard,
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";
import { createFeishuClient } from "./client.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id?: string;
    union_id?: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  open_message_id?: string;
  context: {
    open_message_id?: string;
    open_id?: string;
    user_id?: string;
    chat_id?: string;
  };
};

const FEISHU_APPROVAL_CARD_TTL_MS = 5 * 60_000;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 60_000;
const processedCardActionTokens = new Map<
  string,
  { status: "inflight" | "completed"; expiresAt: number }
>();

export class FeishuRetryableCardActionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FeishuRetryableCardActionError";
  }
}

export function resetProcessedFeishuCardActionTokensForTests(): void {
  processedCardActionTokens.clear();
}

function pruneProcessedCardActionTokens(now: number): void {
  for (const [key, entry] of processedCardActionTokens.entries()) {
    if (entry.expiresAt <= now) {
      processedCardActionTokens.delete(key);
    }
  }
}

function beginFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  pruneProcessedCardActionTokens(now);
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return false;
  }
  const key = `${params.accountId}:${normalizedToken}`;
  const existing = processedCardActionTokens.get(key);
  if (existing && existing.expiresAt > now) {
    return false;
  }
  processedCardActionTokens.set(key, {
    status: "inflight",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
  return true;
}

function completeFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.set(`${params.accountId}:${normalizedToken}`, {
    status: "completed",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
}

function releaseFeishuCardActionToken(params: { token: string; accountId: string }): void {
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.delete(`${params.accountId}:${normalizedToken}`);
}

function buildSyntheticMessageEvent(
  event: FeishuCardActionEvent,
  content: string,
  chatType: "p2p" | "group",
): FeishuMessageEvent {
  const replyTargetMessageId = event.context.open_message_id ?? event.open_message_id;
  return {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      ...(replyTargetMessageId ? { reply_target_message_id: replyTargetMessageId } : {}),
      ...(!replyTargetMessageId ? { suppress_reply_target: true } : {}),
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };
}

function resolveCallbackTarget(event: FeishuCardActionEvent): string {
  const chatId = event.context.chat_id?.trim();
  if (chatId) {
    return `chat:${chatId}`;
  }
  return `user:${event.operator.open_id}`;
}

async function dispatchSyntheticCommand(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  command: string;
  account: ReturnType<typeof resolveFeishuRuntimeAccount>;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  chatType?: "p2p" | "group";
}): Promise<void> {
  const resolvedChatType = await resolveCardActionChatType({
    event: params.event,
    account: params.account,
    chatType: params.chatType,
    log: params.runtime?.log ?? console.log,
  });
  await handleFeishuMessage({
    cfg: params.cfg,
    event: buildSyntheticMessageEvent(params.event, params.command, resolvedChatType),
    botOpenId: params.botOpenId,
    runtime: params.runtime,
    accountId: params.accountId,
  });
}

// Feishu's im.chat.get returns two fields:
//   chat_mode: conversation type — "p2p" | "group" | "topic"
//   chat_type: privacy classification — "private" | "public"
// We check chat_mode first because it directly indicates conversation type.
// "private" maps to "p2p" as the safe-failure direction (restrictive DM
// policy) — a private group chat misclassified as p2p is safer than the
// reverse. "topic" and "public" are treated as group semantics.
function normalizeResolvedCardActionChatType(value: unknown): "p2p" | "group" | undefined {
  if (value === "group" || value === "topic" || value === "public") {
    return "group";
  }
  if (value === "p2p" || value === "private") {
    return "p2p";
  }
  return undefined;
}

const resolvedChatTypeCache = new Map<string, { value: "p2p" | "group"; expiresAt: number }>();
const CHAT_TYPE_CACHE_TTL_MS = 30 * 60_000;
const CHAT_TYPE_CACHE_MAX_SIZE = 5_000;

function pruneChatTypeCache(now: number): void {
  for (const [key, entry] of resolvedChatTypeCache.entries()) {
    if (entry.expiresAt <= now) {
      resolvedChatTypeCache.delete(key);
    }
  }
  if (resolvedChatTypeCache.size > CHAT_TYPE_CACHE_MAX_SIZE) {
    const excess = resolvedChatTypeCache.size - CHAT_TYPE_CACHE_MAX_SIZE;
    const iter = resolvedChatTypeCache.keys();
    for (let i = 0; i < excess; i++) {
      const key = iter.next().value;
      if (key !== undefined) {
        resolvedChatTypeCache.delete(key);
      }
    }
  }
}

function sanitizeLogValue(v: string): string {
  return v.replace(/[\r\n]/g, " ").slice(0, 500);
}

async function resolveCardActionChatType(params: {
  event: FeishuCardActionEvent;
  account: ReturnType<typeof resolveFeishuRuntimeAccount>;
  chatType?: "p2p" | "group";
  log: (message: string) => void;
}): Promise<"p2p" | "group"> {
  const explicitChatType = normalizeResolvedCardActionChatType(params.chatType);
  if (explicitChatType) {
    return explicitChatType;
  }

  const chatId = params.event.context.chat_id?.trim();
  if (!chatId) {
    return "p2p";
  }

  const cacheKey = `${params.account.accountId}:${chatId}`;
  const now = Date.now();
  pruneChatTypeCache(now);
  const cached = resolvedChatTypeCache.get(cacheKey);
  if (cached) {
    return cached.value;
  }

  try {
    const response = (await createFeishuClient(params.account).im.chat.get({
      path: { chat_id: chatId },
    })) as { code?: number; msg?: string; data?: { chat_type?: unknown; chat_mode?: unknown } };
    if (response.code === 0) {
      const resolvedChatType =
        normalizeResolvedCardActionChatType(response.data?.chat_mode) ??
        normalizeResolvedCardActionChatType(response.data?.chat_type);
      if (resolvedChatType) {
        resolvedChatTypeCache.set(cacheKey, {
          value: resolvedChatType,
          expiresAt: now + CHAT_TYPE_CACHE_TTL_MS,
        });
        return resolvedChatType;
      }
      params.log(
        `feishu[${params.account.accountId}]: card action missing chat type for chat; defaulting to p2p`,
      );
    } else {
      params.log(
        `feishu[${params.account.accountId}]: failed to resolve chat type: ${sanitizeLogValue(response.msg ?? "unknown error")}; defaulting to p2p`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    params.log(
      `feishu[${params.account.accountId}]: failed to resolve chat type: ${sanitizeLogValue(message)}; defaulting to p2p`,
    );
  }

  return "p2p";
}

async function sendInvalidInteractionNotice(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  reason: "malformed" | "stale" | "wrong_user" | "wrong_conversation";
  accountId?: string;
}): Promise<void> {
  const reasonText =
    params.reason === "stale"
      ? "This card action has expired. Open a fresh launcher card and try again."
      : params.reason === "wrong_user"
        ? "This card action belongs to a different user."
        : params.reason === "wrong_conversation"
          ? "This card action belongs to a different conversation."
          : "This card action payload is invalid.";

  await sendMessageFeishu({
    cfg: params.cfg,
    to: resolveCallbackTarget(params.event),
    text: `⚠️ ${reasonText}`,
    accountId: params.accountId,
  });
}

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  if (!event.token.trim()) {
    log(
      `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: missing token`,
    );
    return;
  }
  const decoded = decodeFeishuCardAction({ event });
  const claimedToken = beginFeishuCardActionToken({
    token: event.token,
    accountId: account.accountId,
  });
  if (!claimedToken) {
    log(`feishu[${account.accountId}]: skipping duplicate card action token ${event.token}`);
    return;
  }

  try {
    if (decoded.kind === "invalid") {
      log(
        `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: ${decoded.reason}`,
      );
      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: decoded.reason,
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    if (decoded.kind === "structured") {
      const { envelope } = decoded;
      log(
        `feishu[${account.accountId}]: handling structured card action ${envelope.a} from ${event.operator.open_id}`,
      );

      if (envelope.a === FEISHU_APPROVAL_REQUEST_ACTION) {
        const command = typeof envelope.m?.command === "string" ? envelope.m.command.trim() : "";
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        const prompt =
          typeof envelope.m?.prompt === "string" && envelope.m.prompt.trim()
            ? envelope.m.prompt
            : `Run \`${command}\` in this Feishu conversation?`;
        await sendCardFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          card: createApprovalCard({
            operatorOpenId: event.operator.open_id,
            chatId: event.context.chat_id || undefined,
            command,
            prompt,
            sessionKey: envelope.c?.s,
            expiresAt: Date.now() + FEISHU_APPROVAL_CARD_TTL_MS,
            chatType: await resolveCardActionChatType({
              event,
              account,
              chatType: envelope.c?.t,
              log,
            }),
            confirmLabel: command === "/reset" ? "Reset" : "Confirm",
          }),
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CANCEL_ACTION) {
        await sendMessageFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          text: "Cancelled.",
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CONFIRM_ACTION || envelope.k === "quick") {
        const command = envelope.q?.trim();
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        await dispatchSyntheticCommand({
          cfg,
          event,
          command,
          account,
          botOpenId: params.botOpenId,
          runtime,
          accountId,
          chatType: envelope.c?.t,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: "malformed",
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    const content = buildFeishuCardActionTextFallback(event);

    log(
      `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
    );

    await dispatchSyntheticCommand({
      cfg,
      event,
      command: content,
      account,
      botOpenId: params.botOpenId,
      runtime,
      accountId,
    });
    completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
  } catch (err) {
    if (err instanceof FeishuRetryableCardActionError) {
      releaseFeishuCardActionToken({ token: event.token, accountId: account.accountId });
    } else {
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
    }
    throw err;
  }
}
