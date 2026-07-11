// Feishu plugin module implements card action behavior.
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { decodeFeishuCardAction, buildFeishuCardActionTextFallback } from "./card-interaction.js";
import {
  createApprovalCard,
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";
import { normalizeFeishuChatType, resolveFeishuChatType } from "./chat-type.js";
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
  resolvedChatTypeCache.clear();
}

function pruneProcessedCardActionTokens(now: number): void {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    processedCardActionTokens.clear();
    return;
  }
  for (const [key, entry] of processedCardActionTokens.entries()) {
    if (!isFutureDateTimestampMs(entry.expiresAt, { nowMs: validNow })) {
      processedCardActionTokens.delete(key);
    }
  }
}

function resolveProcessedCardActionTokenExpiresAt(now: number): number | undefined {
  return resolveExpiresAtMsFromDurationMs(FEISHU_CARD_ACTION_TOKEN_TTL_MS, { nowMs: now });
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
  if (existing && isFutureDateTimestampMs(existing.expiresAt, { nowMs: now })) {
    return false;
  }
  processedCardActionTokens.delete(key);
  const expiresAt = resolveProcessedCardActionTokenExpiresAt(now);
  if (expiresAt !== undefined) {
    processedCardActionTokens.set(key, {
      status: "inflight",
      expiresAt,
    });
  }
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
  const key = `${params.accountId}:${normalizedToken}`;
  const expiresAt = resolveProcessedCardActionTokenExpiresAt(now);
  if (expiresAt === undefined) {
    processedCardActionTokens.delete(key);
    return;
  }
  processedCardActionTokens.set(key, {
    status: "completed",
    expiresAt,
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
  // card-action-c-* IDs are temporary callback tokens, not valid Feishu message IDs.
  // Using them as reply targets causes "Invalid ids" errors from the streaming reply API.
  const isTemporaryCardActionId = replyTargetMessageId?.startsWith("card-action-c-");
  const validReplyTargetId =
    replyTargetMessageId && !isTemporaryCardActionId ? replyTargetMessageId : undefined;
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
      ...(validReplyTargetId ? { reply_target_message_id: validReplyTargetId } : {}),
      ...(validReplyTargetId ? { typing_target_message_id: validReplyTargetId } : {}),
      ...(!validReplyTargetId ? { suppress_reply_target: true } : {}),
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
  channelRuntime?: PluginRuntime["channel"];
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
    channelRuntime: params.channelRuntime,
    accountId: params.accountId,
  });
}

const resolvedChatTypeCache = new Map<string, { value: "p2p" | "group"; expiresAt: number }>();
const CHAT_TYPE_CACHE_TTL_MS = 30 * 60_000;
const CHAT_TYPE_CACHE_MAX_SIZE = 5_000;

function pruneChatTypeCache(now: number): void {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    resolvedChatTypeCache.clear();
    return;
  }
  for (const [key, entry] of resolvedChatTypeCache.entries()) {
    const expiresAt = asDateTimestampMs(entry.expiresAt);
    if (expiresAt === undefined || expiresAt <= validNow) {
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
  return truncateUtf16Safe(v.replace(/[\r\n]/g, " "), 500);
}

function resolveFeishuApprovalCardExpiresAt(nowRaw = Date.now()): number | undefined {
  const now = asDateTimestampMs(nowRaw);
  return now === undefined
    ? undefined
    : resolveExpiresAtMsFromDurationMs(FEISHU_APPROVAL_CARD_TTL_MS, { nowMs: now });
}

function cacheResolvedCardActionChatType(
  cacheKey: string,
  value: "p2p" | "group",
  now: number,
): void {
  const expiresAt = resolveExpiresAtMsFromDurationMs(CHAT_TYPE_CACHE_TTL_MS, { nowMs: now });
  resolvedChatTypeCache.delete(cacheKey);
  if (expiresAt !== undefined) {
    resolvedChatTypeCache.set(cacheKey, { value, expiresAt });
  }
}

async function resolveCardActionChatType(params: {
  event: FeishuCardActionEvent;
  account: ReturnType<typeof resolveFeishuRuntimeAccount>;
  chatType?: "p2p" | "group";
  log: (message: string) => void;
}): Promise<"p2p" | "group"> {
  const explicitChatType = normalizeFeishuChatType(params.chatType);
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
  const cachedExpiresAt = cached ? asDateTimestampMs(cached.expiresAt) : undefined;
  if (cached && cachedExpiresAt !== undefined) {
    return cached.value;
  }
  if (cached) {
    resolvedChatTypeCache.delete(cacheKey);
  }

  try {
    const response = (await createFeishuClient(params.account).im.chat.get({
      path: { chat_id: chatId },
    })) as { code?: number; msg?: string; data?: { chat_type?: unknown; chat_mode?: unknown } };
    if (response.code === 0) {
      const resolvedChatType = resolveFeishuChatType(response.data ?? {});
      if (resolvedChatType) {
        cacheResolvedCardActionChatType(cacheKey, resolvedChatType, now);
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
  channelRuntime?: PluginRuntime["channel"];
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
    log(`feishu[${account.accountId}]: skipping duplicate card action token`);
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
        const expiresAt = resolveFeishuApprovalCardExpiresAt();
        if (expiresAt === undefined) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        await sendCardFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          card: createApprovalCard({
            operatorOpenId: event.operator.open_id,
            chatId: event.context.chat_id || undefined,
            command,
            prompt,
            sessionKey: envelope.c?.s,
            expiresAt,
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
          channelRuntime: params.channelRuntime,
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
      channelRuntime: params.channelRuntime,
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
