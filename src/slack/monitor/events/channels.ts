import type { SlackEventMiddlewareArgs } from "@slack/bolt";

import { loadConfig, writeConfigFile } from "../../../config/config.js";
import { resolveChannelConfigWrites } from "../../../channels/plugins/config-writes.js";
import { danger, warn } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import { migrateSlackChannelConfig } from "../../channel-migration.js";
import type {
  SlackChannelCreatedEvent,
  SlackChannelIdChangedEvent,
  SlackChannelRenamedEvent,
} from "../types.js";

export function registerSlackChannelEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  ctx.app.event(
    "channel_created",
    async ({ event, body }: SlackEventMiddlewareArgs<"channel_created">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) return;

        const payload = event as SlackChannelCreatedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName,
            channelType: "channel",
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({ channelId, channelName });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType: "channel",
        });
        enqueueSystemEvent(`Slack channel created: ${label}.`, {
          sessionKey,
          contextKey: `slack:channel:created:${channelId ?? channelName ?? "unknown"}`,
        });
      } catch (err) {
        ctx.runtime.error?.(danger(`slack channel created handler failed: ${String(err)}`));
      }
    },
  );

  ctx.app.event(
    "channel_rename",
    async ({ event, body }: SlackEventMiddlewareArgs<"channel_rename">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) return;

        const payload = event as SlackChannelRenamedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name_normalized ?? payload.channel?.name;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName,
            channelType: "channel",
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({ channelId, channelName });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType: "channel",
        });
        enqueueSystemEvent(`Slack channel renamed: ${label}.`, {
          sessionKey,
          contextKey: `slack:channel:renamed:${channelId ?? channelName ?? "unknown"}`,
        });
      } catch (err) {
        ctx.runtime.error?.(danger(`slack channel rename handler failed: ${String(err)}`));
      }
    },
  );

  ctx.app.event(
    "channel_id_changed",
    async ({ event, body }: SlackEventMiddlewareArgs<"channel_id_changed">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) return;

        const payload = event as SlackChannelIdChangedEvent;
        const oldChannelId = payload.old_channel_id;
        const newChannelId = payload.new_channel_id;
        if (!oldChannelId || !newChannelId) return;

        const channelInfo = await ctx.resolveChannelName(newChannelId);
        const label = resolveSlackChannelLabel({
          channelId: newChannelId,
          channelName: channelInfo?.name,
        });

        ctx.runtime.log?.(
          warn(`[slack] Channel ID changed: ${oldChannelId} → ${newChannelId} (${label})`),
        );

        if (
          !resolveChannelConfigWrites({
            cfg: ctx.cfg,
            channelId: "slack",
            accountId: ctx.accountId,
          })
        ) {
          ctx.runtime.log?.(
            warn("[slack] Config writes disabled; skipping channel config migration."),
          );
          return;
        }

        const currentConfig = loadConfig();
        const migration = migrateSlackChannelConfig({
          cfg: currentConfig,
          accountId: ctx.accountId,
          oldChannelId,
          newChannelId,
        });

        if (migration.migrated) {
          migrateSlackChannelConfig({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
            oldChannelId,
            newChannelId,
          });
          await writeConfigFile(currentConfig);
          ctx.runtime.log?.(warn("[slack] Channel config migrated and saved successfully."));
        } else if (migration.skippedExisting) {
          ctx.runtime.log?.(
            warn(
              `[slack] Channel config already exists for ${newChannelId}; leaving ${oldChannelId} unchanged`,
            ),
          );
        } else {
          ctx.runtime.log?.(
            warn(
              `[slack] No config found for old channel ID ${oldChannelId}; migration logged only`,
            ),
          );
        }
      } catch (err) {
        ctx.runtime.error?.(danger(`slack channel_id_changed handler failed: ${String(err)}`));
      }
    },
  );
}
