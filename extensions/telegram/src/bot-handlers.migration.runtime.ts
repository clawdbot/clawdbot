// Telegram group-to-supergroup config migration handler.
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-helpers";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";

export function registerTelegramMigrationHandler({
  cfg,
  accountId,
  bot,
  runtime,
  telegramDeps,
  shouldSkipUpdate,
}: RegisterTelegramHandlerParams) {
  // Handle group migration to supergroup (chat ID changes)
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = msg.chat.title ?? "Unknown";

      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));

      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }

      // Check if old chat ID has config and migrate it
      const currentConfig = telegramDeps.getRuntimeConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId,
      });

      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await mutateConfigFile({
          afterWrite: { mode: "auto" },
          mutate: (draft) => {
            migrateTelegramGroupConfig({ cfg: draft, accountId, oldChatId, newChatId });
          },
        });
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
      throw err;
    }
  });
}
