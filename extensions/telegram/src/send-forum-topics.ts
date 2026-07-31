import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  createTelegramNonIdempotentRequestWithDiag,
  createTelegramRequestWithDiag,
  normalizeMessageId,
  resolveAndPersistChatId,
  resolveTelegramApiContext,
  withTelegramApiContextLease,
  type TelegramApiContext,
  type TelegramApiOverride,
} from "./send-context.js";
import type { OpenClawConfig } from "./send.runtime.js";
import { parseTelegramTarget } from "./targets.js";

type TelegramDeleteOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  notify?: boolean;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
};
type TelegramCreateForumTopicParams = NonNullable<
  Parameters<TelegramApiContext["api"]["createForumTopic"]>[2]
>;

type TelegramEditForumTopicOpts = TelegramDeleteOpts & {
  name?: string;
  iconCustomEmojiId?: string;
};

export async function editForumTopicTelegram(
  chatIdInput: string | number,
  messageThreadIdInput: string | number,
  opts: TelegramEditForumTopicOpts,
): Promise<{
  ok: true;
  chatId: string;
  messageThreadId: number;
  name?: string;
  iconCustomEmojiId?: string;
}> {
  const nameProvided = opts.name !== undefined;
  const trimmedName = opts.name?.trim();
  if (nameProvided && !trimmedName) {
    throw new Error("Telegram forum topic name is required");
  }
  if (trimmedName && trimmedName.length > 128) {
    throw new Error("Telegram forum topic name must be 128 characters or fewer");
  }
  const iconProvided = opts.iconCustomEmojiId !== undefined;
  const trimmedIconCustomEmojiId = opts.iconCustomEmojiId?.trim();
  if (iconProvided && !trimmedIconCustomEmojiId) {
    throw new Error("Telegram forum topic icon custom emoji ID is required");
  }
  if (!trimmedName && !trimmedIconCustomEmojiId) {
    throw new Error("Telegram forum topic update requires a name or iconCustomEmojiId");
  }

  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    editForumTopicTelegramWithContext(chatIdInput, messageThreadIdInput, opts, context),
  );
}

async function editForumTopicTelegramWithContext(
  chatIdInput: string | number,
  messageThreadIdInput: string | number,
  opts: TelegramEditForumTopicOpts,
  context: TelegramApiContext,
): Promise<{
  ok: true;
  chatId: string;
  messageThreadId: number;
  name?: string;
  iconCustomEmojiId?: string;
}> {
  const trimmedName = opts.name?.trim();
  const trimmedIconCustomEmojiId = opts.iconCustomEmojiId?.trim();
  const { cfg, account, api } = context;
  const rawTarget = String(chatIdInput);
  const target = parseTelegramTarget(rawTarget);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
  const messageThreadId = normalizeMessageId(messageThreadIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  const payload = {
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(trimmedIconCustomEmojiId ? { icon_custom_emoji_id: trimmedIconCustomEmojiId } : {}),
  };
  await requestWithDiag(
    () => api.editForumTopic(chatId, messageThreadId, payload),
    "editForumTopic",
  );
  logVerbose(`[telegram] Edited forum topic ${messageThreadId} in chat ${chatId}`);
  return {
    ok: true,
    chatId,
    messageThreadId,
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(trimmedIconCustomEmojiId ? { iconCustomEmojiId: trimmedIconCustomEmojiId } : {}),
  };
}

export async function renameForumTopicTelegram(
  chatIdInput: string | number,
  messageThreadIdInput: string | number,
  name: string,
  opts: TelegramDeleteOpts,
): Promise<{ ok: true; chatId: string; messageThreadId: number; name: string }> {
  const result = await editForumTopicTelegram(chatIdInput, messageThreadIdInput, {
    ...opts,
    name,
  });
  return {
    ok: true,
    chatId: result.chatId,
    messageThreadId: result.messageThreadId,
    name: result.name ?? name.trim(),
  };
}

// ---------------------------------------------------------------------------
// Forum topic creation
// ---------------------------------------------------------------------------

type TelegramCreateForumTopicOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  api?: TelegramApiOverride;
  verbose?: boolean;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
  /** Icon color for the topic (must be one of 0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F). */
  iconColor?: TelegramCreateForumTopicParams["icon_color"];
  /** Custom emoji ID for the topic icon. */
  iconCustomEmojiId?: string;
};

type TelegramCreateForumTopicResult = {
  topicId: number;
  name: string;
  chatId: string;
};

/**
 * Create a forum topic in a Telegram supergroup.
 * Requires the bot to have `can_manage_topics` permission.
 *
 * @param chatId - Supergroup chat ID
 * @param name - Topic name (1-128 characters)
 * @param opts - Optional configuration
 */
export async function createForumTopicTelegram(
  chatId: string,
  name: string,
  opts: TelegramCreateForumTopicOpts,
): Promise<TelegramCreateForumTopicResult> {
  if (!name?.trim()) {
    throw new Error("Forum topic name is required");
  }
  const trimmedName = name.trim();
  if (trimmedName.length > 128) {
    throw new Error("Forum topic name must be 128 characters or fewer");
  }

  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    createForumTopicTelegramWithContext(chatId, name, opts, context),
  );
}

async function createForumTopicTelegramWithContext(
  chatId: string,
  name: string,
  opts: TelegramCreateForumTopicOpts,
  context: TelegramApiContext,
): Promise<TelegramCreateForumTopicResult> {
  const trimmedName = name.trim();
  const { cfg, account, api } = context;
  // Accept topic-qualified targets (e.g. telegram:group:<id>:topic:<thread>)
  // but createForumTopic must always target the base supergroup chat id.
  const target = parseTelegramTarget(chatId);
  const normalizedChatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: chatId,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });

  const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });

  const extra: TelegramCreateForumTopicParams = {};
  if (opts.iconColor != null) {
    extra.icon_color = opts.iconColor;
  }
  if (opts.iconCustomEmojiId?.trim()) {
    extra.icon_custom_emoji_id = opts.iconCustomEmojiId.trim();
  }

  const hasExtra = Object.keys(extra).length > 0;
  const result = await requestWithDiag(
    () => api.createForumTopic(normalizedChatId, trimmedName, hasExtra ? extra : undefined),
    "createForumTopic",
  );

  const topicId = result.message_thread_id;

  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    topicId,
    name: result.name ?? trimmedName,
    chatId: normalizedChatId,
  };
}
