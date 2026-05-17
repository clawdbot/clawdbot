import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type { SlackMessageChangedEvent } from "../types.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

type SlackAssistantMessageRecord = {
  bot_id?: unknown;
  user?: unknown;
  text?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  files?: unknown;
  attachments?: unknown;
  assistant_thread?: unknown;
  metadata?: unknown;
  blocks?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(value);
}

function addUserCandidate(candidates: Set<string>, value: unknown, botUserId: string): void {
  const id = asString(value);
  if (!id || id === botUserId || !isSlackUserId(id)) {
    return;
  }
  candidates.add(id);
}

function collectMetadataUserCandidates(
  candidates: Set<string>,
  value: unknown,
  botUserId: string,
): void {
  const metadata = asRecord(value);
  const payload = asRecord(metadata?.event_payload);
  if (!payload) {
    return;
  }
  for (const key of ["user", "user_id", "actor_user_id", "author_user_id", "slack_user_id"]) {
    addUserCandidate(candidates, payload[key], botUserId);
  }
}

function resolveAssistantMessageChangedSender(params: {
  message?: SlackAssistantMessageRecord;
  botUserId: string;
}): string | undefined {
  const candidates = new Set<string>();
  collectMetadataUserCandidates(candidates, params.message?.metadata, params.botUserId);
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function isSelfAttributedMessageChange(params: {
  event: SlackMessageChangedEvent;
  message?: SlackAssistantMessageRecord;
  ctx: SlackMonitorContext;
}): boolean {
  const topUser = asString((params.event as SlackMessageChangedEvent & { user?: unknown }).user);
  const messageUser = asString(params.message?.user);
  const messageBotId = asString(params.message?.bot_id);
  return (
    (Boolean(params.ctx.botUserId) &&
      (topUser === params.ctx.botUserId || messageUser === params.ctx.botUserId)) ||
    (Boolean(params.ctx.botId) && messageBotId === params.ctx.botId)
  );
}

function resolveAssistantMessageChangedInbound(params: {
  event: SlackMessageEvent;
  ctx: SlackMonitorContext;
}): SlackMessageEvent | undefined {
  if (params.event.subtype !== "message_changed") {
    return undefined;
  }
  const changed = params.event as SlackMessageChangedEvent;
  const message = asRecord(changed.message) as SlackAssistantMessageRecord | undefined;
  if (!message || !isSelfAttributedMessageChange({ event: changed, message, ctx: params.ctx })) {
    return undefined;
  }
  const channelType = normalizeSlackChannelType(
    asString((changed as SlackMessageChangedEvent & { channel_type?: unknown }).channel_type),
    changed.channel,
  );
  if (channelType !== "im") {
    return undefined;
  }
  const senderId = resolveAssistantMessageChangedSender({
    message,
    botUserId: params.ctx.botUserId,
  });
  if (!senderId) {
    if (shouldLogVerbose()) {
      logVerbose(
        `slack: assistant_app_thread message_changed in DM channel=${changed.channel} dropped: no sender resolved from metadata`,
      );
    }
    return undefined;
  }
  return {
    type: "message",
    channel: changed.channel ?? params.event.channel,
    channel_type: "im",
    user: senderId,
    text: asString(message.text),
    ts: asString(message.ts) ?? asString(changed.event_ts),
    thread_ts: asString(message.thread_ts),
    event_ts: changed.event_ts,
    assistant_thread:
      asRecord(message.assistant_thread) ??
      asRecord(
        (changed as SlackMessageChangedEvent & { assistant_thread?: unknown }).assistant_thread,
      ),
    files: Array.isArray(message.files) ? (message.files as SlackMessageEvent["files"]) : undefined,
    attachments: Array.isArray(message.attachments)
      ? (message.attachments as SlackMessageEvent["attachments"])
      : undefined,
  };
}

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const handleIncomingMessageEvent = async ({ event, body }: { event: unknown; body: unknown }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = event as SlackMessageEvent;
      const assistantChangedInbound = resolveAssistantMessageChangedInbound({
        event: message,
        ctx,
      });
      if (assistantChangedInbound) {
        await handleSlackMessage(assistantChangedInbound, { source: "message" });
        return;
      }

      if (
        message.subtype === "message_changed" &&
        isSelfAttributedMessageChange({
          event: message as SlackMessageChangedEvent,
          message: asRecord((message as SlackMessageChangedEvent).message) as
            | SlackAssistantMessageRecord
            | undefined,
          ctx,
        })
      ) {
        return;
      }

      const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
      if (subtypeHandler) {
        const channelId = subtypeHandler.resolveChannelId(message);
        const ingressContext = await authorizeAndResolveSlackSystemEventContext({
          ctx,
          senderId: subtypeHandler.resolveSenderId(message),
          channelId,
          channelType: subtypeHandler.resolveChannelType(message),
          eventKind: subtypeHandler.eventKind,
        });
        if (!ingressContext) {
          return;
        }
        enqueueSystemEvent(subtypeHandler.describe(ingressContext.channelLabel), {
          sessionKey: ingressContext.sessionKey,
          contextKey: subtypeHandler.contextKey(message),
        });
        return;
      }

      await handleSlackMessage(message, { source: "message" });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack handler failed: ${formatErrorMessage(err)}`));
    }
  };

  // NOTE: Slack Event Subscriptions use names like "message.channels" and
  // "message.groups" to control *which* message events are delivered, but the
  // actual event payload always arrives with `type: "message"`.  The
  // `channel_type` field ("channel" | "group" | "im" | "mpim") distinguishes
  // the source.  Bolt rejects `app.event("message.channels")` since v4.6
  // because it is a subscription label, not a valid event type.
  ctx.app.event("message", async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
    await handleIncomingMessageEvent({ event, body });
  });

  ctx.app.event("app_mention", async ({ event, body }: SlackEventMiddlewareArgs<"app_mention">) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const mention = event as SlackAppMentionEvent;

      // Skip app_mention for DMs - they're already handled by message.im event
      // This prevents duplicate processing when both message and app_mention fire for DMs
      const channelType = normalizeSlackChannelType(mention.channel_type, mention.channel);
      if (channelType === "im" || channelType === "mpim") {
        return;
      }

      await handleSlackMessage(mention as unknown as SlackMessageEvent, {
        source: "app_mention",
        wasMentioned: true,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack mention handler failed: ${formatErrorMessage(err)}`));
    }
  });
}
