import type { ReactionType, ReactionTypeEmoji } from "grammy/types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { buildTypingThreadParams } from "./bot/helpers.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import {
  createTelegramRequestWithDiag,
  isTelegramMessageDeleteNoopError,
  resolveAndPersistChatId,
  resolveTelegramApiContext,
  withTelegramApiContextLease,
  type TelegramApi,
  type TelegramApiContext,
} from "./send-context.js";
import type {
  TelegramApiCallOpts,
  TelegramMessageActionOpts,
  TelegramSendOpts,
} from "./send-message-types.js";
import { prepareTelegramOutbound } from "./send-outbound.js";
import { parseTelegramTarget } from "./targets.js";

type TelegramReactionOpts = TelegramApiCallOpts & {
  remove?: boolean;
};

type TelegramTypingOpts = Omit<TelegramApiCallOpts, "gatewayClientScopes"> &
  Pick<TelegramSendOpts, "messageThreadId">;

export async function sendTypingTelegram(
  to: string,
  opts: TelegramTypingOpts,
): Promise<{ ok: true }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(context, sendTypingTelegramWithContext(to, opts, context));
}

async function sendTypingTelegramWithContext(
  to: string,
  opts: TelegramTypingOpts,
  context: TelegramApiContext,
): Promise<{ ok: true }> {
  const { cfg, account, api } = context;
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
  });
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "action" }),
  });
  const threadParams = buildTypingThreadParams(target.messageThreadId ?? opts.messageThreadId);
  await requestWithDiag(
    () =>
      api.sendChatAction(
        chatId,
        "typing",
        threadParams as Parameters<TelegramApi["sendChatAction"]>[2],
      ),
    "typing",
  );
  return { ok: true };
}

export async function reactMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  emoji: string,
  opts: TelegramReactionOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    reactMessageTelegramWithContext(chatIdInput, messageIdInput, emoji, opts, context),
  );
}

async function reactMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  emoji: string,
  opts: TelegramReactionOpts,
  context: TelegramApiContext,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const { api } = context;
  const { chatId, messageId, request } = await prepareTelegramOutbound({
    to: chatIdInput,
    context,
    opts,
    messageIdInput,
    request: {
      kind: "standard",
      shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "react" }),
    },
  });
  const remove = opts.remove === true;
  const trimmedEmoji = emoji.trim();
  // Build the reaction array. We cast emoji to the grammY union type since
  // Telegram validates emoji server-side; invalid emojis fail gracefully.
  const reactions: ReactionType[] =
    remove || !trimmedEmoji
      ? []
      : [{ type: "emoji", emoji: trimmedEmoji as ReactionTypeEmoji["emoji"] }];
  if (typeof api.setMessageReaction !== "function") {
    throw new Error("Telegram reactions are unavailable in this bot API.");
  }
  try {
    await request(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    if (/REACTION_INVALID/i.test(msg)) {
      return { ok: false as const, warning: `Reaction unavailable: ${trimmedEmoji}` };
    }
    throw err;
  }
  return { ok: true };
}

export async function deleteMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramMessageActionOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    deleteMessageTelegramWithContext(chatIdInput, messageIdInput, opts, context),
  );
}

async function deleteMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramMessageActionOpts,
  context: TelegramApiContext,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const { api } = context;
  const { chatId, messageId, request } = await prepareTelegramOutbound({
    to: chatIdInput,
    context,
    opts,
    messageIdInput,
    request: {
      kind: "standard",
      shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "delete" }),
    },
  });
  try {
    await request(() => api.deleteMessage(chatId, messageId), "deleteMessage", {
      shouldLog: (err) => !isTelegramMessageDeleteNoopError(err),
    });
  } catch (err: unknown) {
    if (!isTelegramMessageDeleteNoopError(err)) {
      throw err;
    }
    const detail = formatErrorMessage(err);
    logVerbose(`[telegram] Delete skipped for message ${messageId} in chat ${chatId}: ${detail}`);
    return {
      ok: false,
      warning: `Message ${messageId} was not deleted: ${detail}`,
    };
  }
  logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
  return { ok: true };
}

export async function pinMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramMessageActionOpts,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    pinMessageTelegramWithContext(chatIdInput, messageIdInput, opts, context),
  );
}

async function pinMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramMessageActionOpts,
  context: TelegramApiContext,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { api } = context;
  const { chatId, messageId, request } = await prepareTelegramOutbound({
    to: chatIdInput,
    context,
    opts,
    messageIdInput,
    request: { kind: "standard" },
  });
  await request(
    () =>
      api.pinChatMessage(chatId, messageId, {
        disable_notification: opts.notify !== true,
      }),
    "pinChatMessage",
  );
  logVerbose(`[telegram] Pinned message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
}

export async function unpinMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number | undefined,
  opts: TelegramMessageActionOpts,
): Promise<{ ok: true; chatId: string; messageId?: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    unpinMessageTelegramWithContext(chatIdInput, messageIdInput, opts, context),
  );
}

async function unpinMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number | undefined,
  opts: TelegramMessageActionOpts,
  context: TelegramApiContext,
): Promise<{ ok: true; chatId: string; messageId?: string }> {
  const { api } = context;
  const { chatId, messageId, request } = await prepareTelegramOutbound({
    to: chatIdInput,
    context,
    opts,
    ...(messageIdInput !== undefined ? { messageIdInput } : {}),
    request: { kind: "standard" },
  });
  await request(() => api.unpinChatMessage(chatId, messageId), "unpinChatMessage");
  logVerbose(
    `[telegram] Unpinned ${messageId != null ? `message ${messageId}` : "active message"} in chat ${chatId}`,
  );
  return {
    ok: true,
    chatId,
    ...(messageId != null ? { messageId: String(messageId) } : {}),
  };
}
