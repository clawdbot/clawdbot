import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import { replaceConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { migrateSlackChannelConfig } from "../../channel-migration.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type {
  SlackChannelCreatedEvent,
  SlackChannelIdChangedEvent,
  SlackChannelRenamedEvent,
} from "../types.js";

export function registerSlackChannelEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const enqueueChannelSystemEvent = (params: {
    kind: "created" | "renamed";
    channelId: string | undefined;
    channelName: string | undefined;
  }) => {
    if (
      !ctx.isChannelAllowed({
        channelId: params.channelId,
        channelName: params.channelName,
        channelType: "channel",
      })
    ) {
      return;
    }

    const label = resolveSlackChannelLabel({
      channelId: params.channelId,
      channelName: params.channelName,
    });
    const sessionKey = ctx.resolveSlackSystemEventSessionKey({
      channelId: params.channelId,
      channelType: "channel",
    });
    enqueueSystemEvent(`Slack channel ${params.kind}: ${label}.`, {
      sessionKey,
      contextKey: `slack:channel:${params.kind}:${params.channelId ?? params.channelName ?? "unknown"}`,
    });
  };

  ctx.app.event(
    "channel_created",
    async ({ event, body }: SlackEventMiddlewareArgs<"channel_created">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackChannelCreatedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name;
        enqueueChannelSystemEvent({ kind: "created", channelId, channelName });
      } catch (err) {
        ctx.runtime.error?.(
          danger(`slack channel created handler failed: ${formatErrorMessage(err)}`),
        );
      }
    },
  );

  ctx.app.event(
    "channel_rename",
    async ({ event, body }: SlackEventMiddlewareArgs<"channel_rename">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackChannelRenamedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name_normalized ?? payload.channel?.name;
        enqueueChannelSystemEvent({ kind: "renamed", channelId, channelName });
      } catch (err) {
        ctx.runtime.error?.(
          danger(`slack channel rename handler failed: ${formatErrorMessage(err)}`),
        );
      }
    },
  );

  ctx.app.event(
    "channel_id_changed",
    async ({ event, body }: SlackEventMiddlewareArgs<"channel_id_changed">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackChannelIdChangedEvent;
        const oldChannelId = payload.old_channel_id;
        const newChannelId = payload.new_channel_id;
        if (!oldChannelId || !newChannelId) {
          return;
        }

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

        const currentConfig = getRuntimeConfig();
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
          await replaceConfigFile({
            nextConfig: currentConfig,
            afterWrite: { mode: "auto" },
          });
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
        ctx.runtime.error?.(
          danger(`slack channel_id_changed handler failed: ${formatErrorMessage(err)}`),
        );
      }
    },
  );
}
