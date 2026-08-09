// Slack plugin module implements assistant behavior.
import type { Block, KnownBlock } from "@slack/web-api";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../../errors.js";
import { buildSlackAssistantThreadMetadata, DEFAULT_SLACK_SUGGESTED_PROMPTS } from "../context.js";
import type { SlackMonitorContext, SlackAssistantThreadContext } from "../context.js";
import { resolveSlackIngressTurnLifecycle } from "../ingress.js";
import { isTransientSlackApiError } from "../transient-api-error.js";

type SlackAssistantThreadPayload = {
  user_id?: string;
  context?: SlackAssistantThreadContextPayload;
  channel_id?: string;
  thread_ts?: string;
};

type SlackAssistantThreadContextPayload = {
  channel_id?: string;
  team_id?: string;
  enterprise_id?: string | null;
};

type SlackAssistantThreadStartedEvent = {
  type: "assistant_thread_started";
  assistant_thread?: SlackAssistantThreadPayload;
  context?: SlackAssistantThreadContextPayload;
  event_ts?: string;
};

type SlackAssistantThreadContextChangedEvent = {
  type: "assistant_thread_context_changed";
  assistant_thread?: SlackAssistantThreadPayload;
  context?: SlackAssistantThreadContextPayload;
  event_ts?: string;
};

type SlackAssistantEventHandler<TEvent> = (args: {
  event: TEvent;
  body: unknown;
  context?: unknown;
}) => Promise<void>;

type SlackAssistantEventRegistrar = {
  (
    name: "assistant_thread_started",
    handler: SlackAssistantEventHandler<SlackAssistantThreadStartedEvent>,
  ): void;
  (
    name: "assistant_thread_context_changed",
    handler: SlackAssistantEventHandler<SlackAssistantThreadContextChangedEvent>,
  ): void;
};

function normalizeAssistantThread(
  event: SlackAssistantThreadStartedEvent | SlackAssistantThreadContextChangedEvent,
  getPrevious?: (channelId: string, threadTs: string) => SlackAssistantThreadContext | undefined,
) {
  const thread = event.assistant_thread;
  if (!thread) {
    return null;
  }
  const channelId = thread.channel_id?.trim();
  const threadTs = thread.thread_ts?.trim();
  if (!channelId || !threadTs) {
    return null;
  }
  const previous = getPrevious?.(channelId, threadTs);
  const threadContext = thread.context;
  const eventContext = event.context;
  const resolveContextString = (
    key: keyof Pick<SlackAssistantThreadContextPayload, "channel_id" | "team_id">,
    previousValue: string | undefined,
  ) => threadContext?.[key]?.trim() || eventContext?.[key]?.trim() || previousValue;
  const enterpriseId = (() => {
    if (threadContext && "enterprise_id" in threadContext) {
      return threadContext.enterprise_id === null
        ? null
        : threadContext.enterprise_id?.trim() || previous?.enterpriseId;
    }
    if (eventContext && "enterprise_id" in eventContext) {
      return eventContext.enterprise_id === null
        ? null
        : eventContext.enterprise_id?.trim() || previous?.enterpriseId;
    }
    return previous?.enterpriseId;
  })();
  return {
    assistantChannelId: channelId,
    threadTs,
    userId: thread.user_id?.trim() || previous?.userId,
    channelId: resolveContextString("channel_id", previous?.channelId),
    teamId: resolveContextString("team_id", previous?.teamId),
    enterpriseId,
  };
}

async function persistAssistantThreadMetadata(params: {
  ctx: SlackMonitorContext;
  assistantThread: Omit<SlackAssistantThreadContext, "updatedAt">;
}) {
  const { ctx, assistantThread } = params;
  const response = (await ctx.app.client.conversations.replies({
    token: ctx.botToken,
    channel: assistantThread.assistantChannelId,
    ts: assistantThread.threadTs,
    oldest: assistantThread.threadTs,
    include_all_metadata: true,
    limit: 4,
  })) as {
    messages?: Array<{
      subtype?: string;
      user?: string;
      ts?: string;
      text?: string;
      blocks?: (Block | KnownBlock)[];
    }>;
  };
  const initialMessage = (response.messages ?? []).find(
    (message) => !message.subtype && message.user === ctx.botUserId && message.ts,
  );
  if (!initialMessage?.ts) {
    return;
  }
  await ctx.app.client.chat.update({
    token: ctx.botToken,
    channel: assistantThread.assistantChannelId,
    ts: initialMessage.ts,
    text: initialMessage.text ?? "",
    blocks: Array.isArray(initialMessage.blocks) ? initialMessage.blocks : [],
    metadata: buildSlackAssistantThreadMetadata(assistantThread),
  });
}

export function registerSlackAssistantEvents(params: {
  ctx: SlackMonitorContext;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  const slackApp = ctx.app as unknown as { event: SlackAssistantEventRegistrar };

  const handleEvent: SlackAssistantEventHandler<
    SlackAssistantThreadStartedEvent | SlackAssistantThreadContextChangedEvent
  > = async ({ event, body, context }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();
      const assistantThread = normalizeAssistantThread(event, ctx.getSlackAssistantThreadContext);
      if (!assistantThread) {
        logVerbose(`slack ${event.type} dropped: missing assistant thread channel/thread`);
        return;
      }
      ctx.saveSlackAssistantThreadContext(assistantThread);
      if (event.type === "assistant_thread_started") {
        await ctx.setSlackSuggestedPrompts({
          channelId: assistantThread.assistantChannelId,
          threadTs: assistantThread.threadTs,
          title: "Try asking",
          prompts: DEFAULT_SLACK_SUGGESTED_PROMPTS,
        });
        return;
      }
      await persistAssistantThreadMetadata({ ctx, assistantThread });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack ${event.type} handler failed: ${formatSlackError(err)}`));
      if (resolveSlackIngressTurnLifecycle(context) && isTransientSlackApiError(err)) {
        throw err;
      }
    }
  };

  slackApp.event("assistant_thread_started", handleEvent);
  slackApp.event("assistant_thread_context_changed", handleEvent);
}
