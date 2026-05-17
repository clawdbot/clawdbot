import type { Block, KnownBlock } from "@slack/web-api";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { buildSlackAssistantThreadMetadata } from "../context.js";
import type {
  SlackMonitorContext,
  SlackAssistantSuggestedPrompt,
  SlackAssistantThreadContext,
} from "../context.js";

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

type SlackAssistantEventHandler<TEvent> = (args: { event: TEvent; body: unknown }) => Promise<void>;

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

const DEFAULT_ASSISTANT_PROMPTS: SlackAssistantSuggestedPrompt[] = [
  { title: "What can you do?", message: "What can you help me with?" },
  { title: "Summarize this channel", message: "Summarize the recent activity in this channel." },
  { title: "Draft a reply", message: "Help me draft a reply." },
];

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
  try {
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
  } catch (err) {
    logVerbose(
      `slack assistant thread metadata persist failed for channel ${assistantThread.assistantChannelId}: ${formatErrorMessage(err)}`,
    );
  }
}

export function registerSlackAssistantEvents(params: {
  ctx: SlackMonitorContext;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  const slackApp = ctx.app as unknown as { event: SlackAssistantEventRegistrar };

  slackApp.event("assistant_thread_started", async ({ event, body }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();
      const assistantThread = normalizeAssistantThread(event, ctx.getSlackAssistantThreadContext);
      if (!assistantThread) {
        logVerbose(
          "slack assistant_thread_started dropped: missing assistant thread channel/thread",
        );
        return;
      }
      ctx.saveSlackAssistantThreadContext(assistantThread);
      await ctx.setSlackAssistantSuggestedPrompts({
        channelId: assistantThread.assistantChannelId,
        threadTs: assistantThread.threadTs,
        title: "Try asking",
        prompts: DEFAULT_ASSISTANT_PROMPTS,
      });
    } catch (err) {
      ctx.runtime.error?.(
        danger(`slack assistant_thread_started handler failed: ${formatErrorMessage(err)}`),
      );
    }
  });

  slackApp.event("assistant_thread_context_changed", async ({ event, body }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();
      const assistantThread = normalizeAssistantThread(event, ctx.getSlackAssistantThreadContext);
      if (!assistantThread) {
        logVerbose(
          "slack assistant_thread_context_changed dropped: missing assistant thread channel/thread",
        );
        return;
      }
      ctx.saveSlackAssistantThreadContext(assistantThread);
      await persistAssistantThreadMetadata({ ctx, assistantThread });
    } catch (err) {
      ctx.runtime.error?.(
        danger(`slack assistant_thread_context_changed handler failed: ${formatErrorMessage(err)}`),
      );
    }
  });
}
