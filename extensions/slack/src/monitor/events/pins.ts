// Slack plugin module implements pins behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import type { SlackMonitorContext } from "../context.js";
import type { SlackPinEvent } from "../types.js";
import {
  authorizeAndResolveSlackSystemEventContext,
  resolveSlackListenerEventScope,
} from "./system-event-context.js";

async function handleSlackPinEvent(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  body: unknown;
  context: AllMiddlewareArgs["context"] | undefined;
  client: AllMiddlewareArgs["client"] | undefined;
  event: unknown;
  eventId: string;
  action: "pinned" | "unpinned";
  contextKeySuffix: "added" | "removed";
  errorLabel: string;
}): Promise<void> {
  const {
    ctx,
    trackEvent,
    body,
    context,
    client,
    event,
    eventId,
    action,
    contextKeySuffix,
    errorLabel,
  } = params;

  try {
    const eventScope = resolveSlackListenerEventScope({ ctx, body, context, client });
    if (eventScope === null) {
      return;
    }
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    trackEvent?.();

    const payload = event as SlackPinEvent;
    const channelId = payload.channel_id;
    const ingressContext = await authorizeAndResolveSlackSystemEventContext({
      ctx,
      senderId: payload.user,
      channelId,
      eventKind: "pin",
      eventScope,
    });
    if (!ingressContext) {
      return;
    }
    const userInfo = payload.user
      ? await (eventScope
          ? ctx.resolveUserName(payload.user, eventScope)
          : ctx.resolveUserName(payload.user))
      : {};
    const userLabel = userInfo?.name ?? payload.user ?? "someone";
    const itemType = payload.item?.type ?? "item";
    const messageId = payload.item?.message?.ts ?? payload.event_ts;
    enqueueSystemEvent(
      `Slack: ${userLabel} ${action} a ${itemType} in ${ingressContext.channelLabel}.`,
      {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:pin:${eventScope ? `${eventScope.teamId}:` : ""}${contextKeySuffix}:${channelId ?? "unknown"}:${messageId ?? "unknown"}:${eventId}`,
      },
    );
  } catch (err) {
    ctx.runtime.error?.(danger(`slack ${errorLabel} handler failed: ${formatErrorMessage(err)}`));
  }
}

export function registerSlackPinEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  ctx.app.event(
    "pin_added",
    async (args: SlackEventMiddlewareArgs<"pin_added"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      await handleSlackPinEvent({
        ctx,
        trackEvent,
        body,
        context,
        client,
        event,
        eventId: body.event_id,
        action: "pinned",
        contextKeySuffix: "added",
        errorLabel: "pin added",
      });
    },
  );

  ctx.app.event(
    "pin_removed",
    async (args: SlackEventMiddlewareArgs<"pin_removed"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      await handleSlackPinEvent({
        ctx,
        trackEvent,
        body,
        context,
        client,
        event,
        eventId: body.event_id,
        action: "unpinned",
        contextKeySuffix: "removed",
        errorLabel: "pin removed",
      });
    },
  );
}
