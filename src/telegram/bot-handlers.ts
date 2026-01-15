// @ts-nocheck
import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import { danger, logVerbose, warn } from "../globals.js";
import { resolveMedia } from "./bot/delivery.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";
import type { TelegramMessage } from "./bot/types.js";
import { firstDefined, isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { readTelegramAllowFromStore } from "./pairing-store.js";
import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  groupAllowFrom,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
}) => {
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  type TextFragmentEntry = {
    key: string;
    messages: Array<{ msg: TelegramMessage; ctx: unknown; receivedAtMs: number }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: Array<{ path: string; contentType?: string }> = [];
      for (const { ctx } of entry.messages) {
        const media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
        if (media) {
          allMedia.push({ path: media.path, contentType: media.contentType });
        }
      }

      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) return;

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) return;

      const syntheticMessage: TelegramMessage = {
        ...first.msg,
        text: combinedText,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
        date: last.msg.date ?? first.msg.date,
      };

      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const baseCtx = first.ctx as { me?: unknown; getFile?: unknown } & Record<string, unknown>;
      const getFile =
        typeof baseCtx.getFile === "function" ? baseCtx.getFile.bind(baseCtx) : async () => ({});

      await processMessage(
        { message: syntheticMessage, me: baseCtx.me, getFile },
        [],
        storeAllowFrom,
        { messageIdOverride: String(last.msg.message_id) },
      );
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      textFragmentBuffer.delete(entry.key);
      textFragmentProcessing = textFragmentProcessing
        .then(async () => {
          await flushTextFragments(entry);
        })
        .catch(() => undefined);
      await textFragmentProcessing;
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) return;
    if (shouldSkipUpdate(ctx)) return;
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) return;

      const syntheticMessage: TelegramMessage = {
        ...callbackMessage,
        from: callback.from,
        text: data,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
      };
      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const getFile = typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
      await processMessage({ message: syntheticMessage, me: ctx.me, getFile }, [], storeAllowFrom, {
        forceWasMentioned: true,
        messageIdOverride: callback.id,
      });
    } catch (err) {
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
    } finally {
      await bot.api.answerCallbackQuery(callback.id).catch(() => {});
    }
  });

  // Handle group migration to supergroup (chat ID changes)
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) return;
      if (shouldSkipUpdate(ctx)) return;

      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = (msg.chat as { title?: string }).title ?? "Unknown";

      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));

      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }

      // Check if old chat ID has config and migrate it
      const currentConfig = loadConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId,
      });

      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await writeConfigFile(currentConfig);
        runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
      } else if (migration.skippedExisting) {
        runtime.log?.(
          warn(
            `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
          ),
        );
      } else {
        runtime.log?.(
          warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
        );
      }
    } catch (err) {
      runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
    }
  });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) return;
      if (shouldSkipUpdate(ctx)) return;

      const chatId = msg.chat.id;
      const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
      const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
      const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
      const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const effectiveGroupAllow = normalizeAllowFrom([
        ...(groupAllowOverride ?? groupAllowFrom ?? []),
        ...storeAllowFrom,
      ]);
      const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          return;
        }
        if (hasGroupAllowOverride) {
          const senderId = msg.from?.id;
          const senderUsername = msg.from?.username ?? "";
          const allowed =
            senderId != null &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId ?? "unknown"} (group allowFrom override)`,
            );
            return;
          }
        }
        // Group policy filtering: controls how group messages are handled
        // - "open": groups bypass allowFrom, only mention-gating applies
        // - "disabled": block all group messages entirely
        // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
        const groupPolicy = telegramCfg.groupPolicy ?? "open";
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          return;
        }
        if (groupPolicy === "allowlist") {
          // For allowlist mode, the sender (msg.from.id) must be in allowFrom
          const senderId = msg.from?.id;
          if (senderId == null) {
            logVerbose(`Blocked telegram group message (no sender ID, groupPolicy: allowlist)`);
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            return;
          }
          const senderUsername = msg.from?.username ?? "";
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            })
          ) {
            logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
            return;
          }
        }

        // Group allowlist based on configured group IDs.
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: msg.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          return;
        }
      }

      // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
      // We buffer “near-limit” messages and append immediately-following parts.
      const text = typeof msg.text === "string" ? msg.text : undefined;
      const isCommandLike = (text ?? "").trim().startsWith("/");
      if (text && !isCommandLike) {
        const nowMs = Date.now();
        const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
        const key = `text:${chatId}:${resolvedThreadId ?? "main"}:${senderId}`;
        const existing = textFragmentBuffer.get(key);

        if (existing) {
          const last = existing.messages.at(-1);
          const lastMsgId = last?.msg.message_id;
          const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
          const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
          const timeGapMs = nowMs - lastReceivedAtMs;
          const canAppend =
            idGap > 0 &&
            idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
            timeGapMs >= 0 &&
            timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

          if (canAppend) {
            const currentTotalChars = existing.messages.reduce(
              (sum, m) => sum + (m.msg.text?.length ?? 0),
              0,
            );
            const nextTotalChars = currentTotalChars + text.length;
            if (
              existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
              nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
            ) {
              existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
              scheduleTextFragmentFlush(existing);
              return;
            }
          }

          // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
          clearTimeout(existing.timer);
          textFragmentBuffer.delete(key);
          textFragmentProcessing = textFragmentProcessing
            .then(async () => {
              await flushTextFragments(existing);
            })
            .catch(() => undefined);
          await textFragmentProcessing;
        }

        const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
        if (shouldStart) {
          const entry: TextFragmentEntry = {
            key,
            messages: [{ msg, ctx, receivedAtMs: nowMs }],
            timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
          };
          textFragmentBuffer.set(key, entry);
          scheduleTextFragmentFlush(entry);
          return;
        }
      }

      // Media group handling - buffer multi-image messages
      const mediaGroupId = (msg as { media_group_id?: string }).media_group_id;
      if (mediaGroupId) {
        const existing = mediaGroupBuffer.get(mediaGroupId);
        if (existing) {
          clearTimeout(existing.timer);
          existing.messages.push({ msg, ctx });
          existing.timer = setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            mediaGroupProcessing = mediaGroupProcessing
              .then(async () => {
                await processMediaGroup(existing);
              })
              .catch(() => undefined);
            await mediaGroupProcessing;
          }, MEDIA_GROUP_TIMEOUT_MS);
        } else {
          const entry: MediaGroupEntry = {
            messages: [{ msg, ctx }],
            timer: setTimeout(async () => {
              mediaGroupBuffer.delete(mediaGroupId);
              mediaGroupProcessing = mediaGroupProcessing
                .then(async () => {
                  await processMediaGroup(entry);
                })
                .catch(() => undefined);
              await mediaGroupProcessing;
            }, MEDIA_GROUP_TIMEOUT_MS),
          };
          mediaGroupBuffer.set(mediaGroupId, entry);
        }
        return;
      }

      let media: Awaited<ReturnType<typeof resolveMedia>> = null;
      try {
        media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
      } catch (mediaErr) {
        const errMsg = String(mediaErr);
        if (errMsg.includes("exceeds") && errMsg.includes("MB limit")) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await bot.api
            .sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
              reply_to_message_id: msg.message_id,
            })
            .catch(() => {});
          logger.warn({ chatId, error: errMsg }, "media exceeds size limit");
          return;
        }
        throw mediaErr;
      }
      const allMedia = media ? [{ path: media.path, contentType: media.contentType }] : [];
      await processMessage(ctx, allMedia, storeAllowFrom);
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });
};
