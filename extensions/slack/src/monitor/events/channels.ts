// Slack plugin module implements channels behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import {
  mutateConfigFile,
  readConfigFileSnapshotForWrite,
} from "openclaw/plugin-sdk/config-mutation";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { migrateSlackChannelConfig } from "../../channel-migration.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import { resolveSlackIngressTurnLifecycle } from "../ingress.js";
import type {
  SlackChannelCreatedEvent,
  SlackChannelIdChangedEvent,
  SlackChannelRenamedEvent,
} from "../types.js";
import { resolveSlackListenerEventScope } from "./system-event-context.js";

export function registerSlackChannelEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const enqueueChannelSystemEvent = (paramsLocal: {
    kind: "created" | "renamed";
    channelId: string | undefined;
    channelName: string | undefined;
    eventId: string;
    eventScope?: SlackEventScope;
  }) => {
    if (
      !ctx.isChannelAllowed({
        teamId: paramsLocal.eventScope?.teamId ?? ctx.teamId,
        channelId: paramsLocal.channelId,
        channelName: paramsLocal.channelName,
        channelType: "channel",
      })
    ) {
      return;
    }

    const label = resolveSlackChannelLabel({
      channelId: paramsLocal.channelId,
      channelName: paramsLocal.channelName,
    });
    const sessionKey = ctx.resolveSlackSystemEventSessionKey({
      channelId: paramsLocal.channelId,
      channelType: "channel",
      eventScope: paramsLocal.eventScope,
    });
    enqueueSystemEvent(`Slack channel ${paramsLocal.kind}: ${label}.`, {
      sessionKey,
      contextKey: `slack:channel:${paramsLocal.eventScope ? `${paramsLocal.eventScope.teamId}:` : ""}${paramsLocal.kind}:${paramsLocal.channelId ?? paramsLocal.channelName ?? "unknown"}:${paramsLocal.eventId}`,
    });
  };

  ctx.app.event(
    "channel_created",
    async (args: SlackEventMiddlewareArgs<"channel_created"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      const eventScope = resolveSlackListenerEventScope({ ctx, body, context, client });
      if (eventScope === null) {
        return;
      }
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();

      const payload = event as SlackChannelCreatedEvent;
      const channelId = payload.channel?.id;
      const channelName = payload.channel?.name;
      enqueueChannelSystemEvent({
        kind: "created",
        channelId,
        channelName,
        eventId: body.event_id,
        eventScope,
      });
    },
  );

  ctx.app.event(
    "channel_rename",
    async (args: SlackEventMiddlewareArgs<"channel_rename"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      const eventScope = resolveSlackListenerEventScope({ ctx, body, context, client });
      if (eventScope === null) {
        return;
      }
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();

      const payload = event as SlackChannelRenamedEvent;
      const channelId = payload.channel?.id;
      const channelName = payload.channel?.name_normalized ?? payload.channel?.name;
      enqueueChannelSystemEvent({
        kind: "renamed",
        channelId,
        channelName,
        eventId: body.event_id,
        eventScope,
      });
    },
  );
}

export function registerSlackChannelIdChangedEvent(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  ctx.app.event(
    "channel_id_changed",
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"channel_id_changed"> & AllMiddlewareArgs) => {
      const turnAdoptionLifecycle = resolveSlackIngressTurnLifecycle(context);
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

        const { snapshot } = await readConfigFileSnapshotForWrite();
        const previewConfig = structuredClone(snapshot.sourceConfig);
        const preview = migrateSlackChannelConfig({
          cfg: previewConfig,
          accountId: ctx.accountId,
          oldChannelId,
          newChannelId,
        });

        if (preview.migrated) {
          const persisted = await mutateConfigFile({
            baseHash: snapshot.hash ?? undefined,
            afterWrite: { mode: "auto" },
            mutate: (draft) =>
              migrateSlackChannelConfig({
                cfg: draft,
                accountId: ctx.accountId,
                oldChannelId,
                newChannelId,
              }),
          });
          if (persisted.result?.migrated) {
            // Persistence owns the migration. Update this monitor's captured
            // config only after the durable write succeeds.
            migrateSlackChannelConfig({
              cfg: ctx.cfg,
              accountId: ctx.accountId,
              oldChannelId,
              newChannelId,
            });
            ctx.runtime.log?.(warn("[slack] Channel config migrated and saved successfully."));
          }
        } else if (preview.skippedExisting) {
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
        if (turnAdoptionLifecycle) {
          throw err;
        }
      }
    },
  );
}
