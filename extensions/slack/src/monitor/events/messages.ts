// Slack plugin module implements messages behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  shouldLogVerbose,
} from "openclaw/plugin-sdk/runtime-env";
import {
  asOptionalRecord as asRecord,
  normalizeOptionalString as asString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { noteSlackDraftConversationMessage } from "../../draft-message-boundaries.js";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackListenerEventScope, type SlackEventScope } from "../event-scope.js";
import { resolveSlackIngressTurnLifecycle } from "../ingress.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type { SlackMessageChangedEvent } from "../types.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

// Mirrors the Telegram `[telegram]` inbound logger so cross-channel journal-grep
// workflows are uniform; the `gateway/channels/slack` subsystem renders as `[slack]`.
const slackInboundLog = createSubsystemLogger("gateway/channels/slack").child("inbound");

function formatSlackInboundLogLine(params: {
  workspaceId: string;
  channelId: string;
  channelType: string;
  userId: string;
  botUserId: string;
  bodyChars: number;
}): string {
  const from = `slack:${params.workspaceId}:channel:${params.channelId}:user:${params.userId}`;
  return `Inbound app_mention ${from} -> bot:${params.botUserId} (${params.channelType}, ${params.bodyChars} chars)`;
}

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

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(value);
}

function isBotAuthoredEnterpriseEvent(event: { bot_id?: unknown; subtype?: unknown }): boolean {
  return Boolean(asString(event.bot_id)) || event.subtype === "bot_message";
}

async function resolveSlackAppMentionChannelType(params: {
  ctx: SlackMonitorContext;
  eventScope?: SlackEventScope;
  mention: SlackAppMentionEvent;
}): Promise<SlackMessageEvent["channel_type"] | undefined> {
  const explicitType = asString(params.mention.channel_type);
  if (explicitType) {
    return normalizeSlackChannelType(explicitType, params.mention.channel);
  }
  const rememberedType = params.ctx.recallSlackChannelType(
    params.mention.channel,
    params.eventScope,
  );
  if (rememberedType) {
    return normalizeSlackChannelType(rememberedType, params.mention.channel);
  }
  // app_mention omits channel_type, and Slack ID prefixes are not a type contract.
  // Only an authoritative event/cache/API type may choose this event's owner.
  const resolved = await params.ctx
    .resolveChannelName(params.mention.channel, params.eventScope)
    .catch(() => ({ type: undefined }));
  return resolved.type
    ? normalizeSlackChannelType(resolved.type, params.mention.channel)
    : undefined;
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
    blocks: Array.isArray(message.blocks)
      ? (message.blocks as SlackMessageEvent["blocks"])
      : undefined,
  };
}

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const resolveEventScope = (args: {
    body: unknown;
    context: AllMiddlewareArgs["context"];
    client: AllMiddlewareArgs["client"];
  }) =>
    resolveSlackListenerEventScope({
      identity: ctx.installationIdentity,
      body: args.body,
      context: args.context,
      client: args.client,
      clientOptions: ctx.app.webClientOptions,
      onDrop: (reason) => logVerbose(`slack: drop event (${reason})`),
    });

  const noteConversationMessage = (
    message: SlackMessageEvent | SlackAppMentionEvent,
    eventScope?: SlackEventScope,
  ) => {
    noteSlackDraftConversationMessage({
      accountId: ctx.accountId,
      teamId: eventScope?.teamId,
      channelId: message.channel,
      threadTs: message.thread_ts,
      messageTs: message.ts ?? message.event_ts,
      userId: asString(message.user),
      botUserId: ctx.botUserId,
      botId: asString(message.bot_id),
      subtype: "subtype" in message ? asString(message.subtype) : undefined,
    });
  };

  const handleIncomingMessageEvent = async ({
    event,
    body,
    context,
    client,
  }: {
    event: unknown;
    body: SlackEventMiddlewareArgs<"message">["body"];
    context: AllMiddlewareArgs["context"];
    client: AllMiddlewareArgs["client"];
  }) => {
    const turnAdoptionLifecycle = resolveSlackIngressTurnLifecycle(context);
    try {
      const eventScope = resolveEventScope({ body, context, client });
      if (eventScope === null) {
        return;
      }
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = event as SlackMessageEvent;
      // Subtype handlers do not enter the regular message pipeline. Observe any explicit
      // type here so edits and deletes share the same authoritative conversation cache.
      ctx.rememberSlackChannelType(message.channel, message.channel_type, eventScope);
      if (eventScope && isBotAuthoredEnterpriseEvent(message)) {
        logVerbose("slack: drop enterprise bot-authored message");
        return;
      }
      if (eventScope && message.subtype && message.subtype !== "file_share") {
        logVerbose(`slack: drop enterprise message subtype=${message.subtype}`);
        return;
      }
      const assistantChangedInbound = resolveAssistantMessageChangedInbound({
        event: message,
        ctx,
      });
      if (assistantChangedInbound) {
        noteConversationMessage(assistantChangedInbound, eventScope);
        await handleSlackMessage(assistantChangedInbound, {
          source: "message",
          eventScope,
          ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
          ...(eventScope || turnAdoptionLifecycle ? { awaitDispatch: true } : {}),
        });
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
          eventScope,
        });
        if (!ingressContext) {
          return;
        }
        enqueueSystemEvent(subtypeHandler.describe(ingressContext.channelLabel), {
          sessionKey: ingressContext.sessionKey,
          contextKey: `${subtypeHandler.contextKey(message)}:${body.event_id}`,
        });
        return;
      }

      noteConversationMessage(message, eventScope);
      await handleSlackMessage(message, {
        source: "message",
        eventScope,
        ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
        ...(eventScope || turnAdoptionLifecycle ? { awaitDispatch: true } : {}),
      });
    } catch (err) {
      if (turnAdoptionLifecycle) {
        throw err;
      }
      ctx.runtime.error?.(danger(`slack handler failed: ${formatErrorMessage(err)}`));
    }
  };

  // NOTE: Slack Event Subscriptions use names like "message.channels" and
  // "message.groups" to control *which* message events are delivered, but the
  // actual event payload always arrives with `type: "message"`.  The
  // `channel_type` field ("channel" | "group" | "im" | "mpim") distinguishes
  // the source.  Bolt rejects `app.event("message.channels")` since v4.6
  // because it is a subscription label, not a valid event type.
  ctx.app.event(
    "message",
    async (args: SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs) => {
      await handleIncomingMessageEvent(args);
    },
  );

  ctx.app.event(
    "app_mention",
    async (args: SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      const turnAdoptionLifecycle = resolveSlackIngressTurnLifecycle(context);
      try {
        const eventScope = resolveEventScope({ body, context, client });
        if (eventScope === null) {
          return;
        }
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }

        const mention = event as SlackAppMentionEvent;
        if (eventScope && isBotAuthoredEnterpriseEvent(mention)) {
          logVerbose("slack: drop enterprise bot-authored app_mention");
          return;
        }

        // DM and MPIM messages are owned by message.im/message.mpim. Resolve the
        // omitted type before this guard so event ordering cannot change ownership.
        const channelType = await resolveSlackAppMentionChannelType({
          ctx,
          mention,
          eventScope,
        });
        if (!channelType) {
          // OpenClaw manifests pair app_mention with message.channels/groups/im/mpim.
          // Never guess here: the canonical message event still owns delivery.
          logVerbose(
            `slack: drop typeless app_mention channel=${mention.channel} (conversation type unresolved; waiting for message event)`,
          );
          return;
        }
        if (channelType === "im" || channelType === "mpim") {
          return;
        }

        // Emit a per-inbound receipt before dispatch so a silently-dropped mention
        // (e.g. router consumes it without a tool call) still leaves journal evidence,
        // matching the Telegram inbound log. Runs after the DM drop above, so duplicate
        // DM app_mention events (already handled via message.im) produce no line.
        slackInboundLog.info(
          formatSlackInboundLogLine({
            workspaceId: eventScope?.teamId ?? ctx.teamId,
            channelId: mention.channel,
            channelType: channelType ?? "channel",
            userId: asString(mention.user) ?? "unknown",
            botUserId: ctx.botUserId,
            bodyChars: asString(mention.text)?.length ?? 0,
          }),
        );

        noteConversationMessage(mention, eventScope);
        await handleSlackMessage(mention as unknown as SlackMessageEvent, {
          source: "app_mention",
          wasMentioned: true,
          eventScope,
          ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
          ...(eventScope || turnAdoptionLifecycle ? { awaitDispatch: true } : {}),
        });
      } catch (err) {
        if (turnAdoptionLifecycle) {
          throw err;
        }
        ctx.runtime.error?.(danger(`slack mention handler failed: ${formatErrorMessage(err)}`));
      }
    },
  );
}
