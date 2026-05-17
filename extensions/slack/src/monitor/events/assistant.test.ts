import type { App } from "@slack/bolt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "../context.js";
import { registerSlackAssistantEvents } from "./assistant.js";

type Handler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

function createHarness(overrides?: {
  shouldDrop?: boolean;
  existingContext?: ReturnType<SlackMonitorContext["getSlackAssistantThreadContext"]>;
  replies?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}) {
  const handlers: Record<string, Handler> = {};
  const getSlackAssistantThreadContext = vi.fn(() => overrides?.existingContext);
  const saveSlackAssistantThreadContext = vi.fn();
  const setSlackAssistantSuggestedPrompts = vi.fn(async () => true);
  const replies = overrides?.replies ?? vi.fn(async () => ({ messages: [] }));
  const update = overrides?.update ?? vi.fn(async () => ({}));
  const trackEvent = vi.fn();
  const ctx = {
    app: {
      client: {
        conversations: { replies },
        chat: { update },
      },
      event: (name: string, handler: Handler) => {
        handlers[name] = handler;
      },
    } as unknown as App,
    runtime: { error: vi.fn() },
    botToken: "xoxb-test",
    botUserId: "B1",
    shouldDropMismatchedSlackEvent: () => overrides?.shouldDrop === true,
    getSlackAssistantThreadContext,
    saveSlackAssistantThreadContext,
    setSlackAssistantSuggestedPrompts,
  } as unknown as SlackMonitorContext;
  registerSlackAssistantEvents({ ctx, trackEvent });
  return {
    handlers,
    getSlackAssistantThreadContext,
    saveSlackAssistantThreadContext,
    setSlackAssistantSuggestedPrompts,
    replies,
    update,
    trackEvent,
  };
}

function makeThreadEvent(type: string) {
  return {
    type,
    assistant_thread: {
      user_id: "U123",
      channel_id: "D123",
      thread_ts: "1729999327.187299",
      context: {
        channel_id: "C456",
        team_id: "T789",
        enterprise_id: "E123",
      },
    },
  };
}

function makeTopLevelContextThreadEvent(type: string) {
  return {
    type,
    assistant_thread: {
      user_id: "U123",
      channel_id: "D123",
      thread_ts: "1729999327.187299",
    },
    context: {
      channel_id: "C456",
      team_id: "T789",
      enterprise_id: "E123",
    },
  };
}

describe("registerSlackAssistantEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores new assistant thread context and sets default prompts", async () => {
    const harness = createHarness();

    await harness.handlers.assistant_thread_started?.({
      event: makeThreadEvent("assistant_thread_started"),
      body: {},
    });

    expect(harness.trackEvent).toHaveBeenCalledTimes(1);
    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledWith({
      assistantChannelId: "D123",
      threadTs: "1729999327.187299",
      userId: "U123",
      channelId: "C456",
      teamId: "T789",
      enterpriseId: "E123",
    });
    expect(harness.setSlackAssistantSuggestedPrompts).toHaveBeenCalledWith({
      channelId: "D123",
      threadTs: "1729999327.187299",
      title: "Try asking",
      prompts: [
        { title: "What can you do?", message: "What can you help me with?" },
        {
          title: "Summarize this channel",
          message: "Summarize the recent activity in this channel.",
        },
        { title: "Draft a reply", message: "Help me draft a reply." },
      ],
    });
  });

  it("updates assistant thread context without resetting prompts", async () => {
    const harness = createHarness();

    await harness.handlers.assistant_thread_context_changed?.({
      event: makeThreadEvent("assistant_thread_context_changed"),
      body: {},
    });

    expect(harness.trackEvent).toHaveBeenCalledTimes(1);
    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledTimes(1);
    expect(harness.setSlackAssistantSuggestedPrompts).not.toHaveBeenCalled();
  });

  it("persists changed assistant thread context onto the first bot message", async () => {
    const replies = vi.fn(async () => ({
      messages: [
        { user: "U123", ts: "1729999327.200000", text: "user asks" },
        {
          user: "B1",
          ts: "1729999327.300000",
          text: "assistant reply",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "assistant reply" } }],
        },
      ],
    }));
    const update = vi.fn(async () => ({}));
    const harness = createHarness({ replies, update });

    await harness.handlers.assistant_thread_context_changed?.({
      event: makeThreadEvent("assistant_thread_context_changed"),
      body: {},
    });

    expect(replies).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "D123",
      ts: "1729999327.187299",
      oldest: "1729999327.187299",
      include_all_metadata: true,
      limit: 4,
    });
    expect(update).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "D123",
      ts: "1729999327.300000",
      text: "assistant reply",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "assistant reply" } }],
      metadata: {
        event_type: "assistant_thread_context",
        event_payload: {
          channel_id: "C456",
          team_id: "T789",
          enterprise_id: "E123",
        },
      },
    });
  });

  it("accepts Slack assistant context when it is sent beside the thread", async () => {
    const harness = createHarness();

    await harness.handlers.assistant_thread_context_changed?.({
      event: makeTopLevelContextThreadEvent("assistant_thread_context_changed"),
      body: {},
    });

    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledWith({
      assistantChannelId: "D123",
      threadTs: "1729999327.187299",
      userId: "U123",
      channelId: "C456",
      teamId: "T789",
      enterpriseId: "E123",
    });
  });

  it("merges partial assistant thread context per field", async () => {
    const harness = createHarness();

    await harness.handlers.assistant_thread_context_changed?.({
      event: {
        type: "assistant_thread_context_changed",
        assistant_thread: {
          user_id: "U123",
          channel_id: "D123",
          thread_ts: "1729999327.187299",
          context: {
            team_id: "T_THREAD",
          },
        },
        context: {
          channel_id: "C456",
          team_id: "T_EVENT",
          enterprise_id: "E123",
        },
      },
      body: {},
    });

    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledWith({
      assistantChannelId: "D123",
      threadTs: "1729999327.187299",
      userId: "U123",
      channelId: "C456",
      teamId: "T_THREAD",
      enterpriseId: "E123",
    });
  });

  it("preserves cached assistant thread context when updates omit optional fields", async () => {
    const harness = createHarness({
      existingContext: {
        assistantChannelId: "D123",
        threadTs: "1729999327.187299",
        userId: "UOLD",
        channelId: "COLD",
        teamId: "TOLD",
        enterpriseId: "EOLD",
        updatedAt: 1,
      },
    });

    await harness.handlers.assistant_thread_context_changed?.({
      event: {
        type: "assistant_thread_context_changed",
        assistant_thread: {
          channel_id: "D123",
          thread_ts: "1729999327.187299",
        },
      },
      body: {},
    });

    expect(harness.getSlackAssistantThreadContext).toHaveBeenCalledWith(
      "D123",
      "1729999327.187299",
    );
    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledWith({
      assistantChannelId: "D123",
      threadTs: "1729999327.187299",
      userId: "UOLD",
      channelId: "COLD",
      teamId: "TOLD",
      enterpriseId: "EOLD",
    });
  });

  it("drops mismatched workspace events before touching assistant state", async () => {
    const harness = createHarness({ shouldDrop: true });

    await harness.handlers.assistant_thread_started?.({
      event: makeThreadEvent("assistant_thread_started"),
      body: {},
    });

    expect(harness.trackEvent).not.toHaveBeenCalled();
    expect(harness.saveSlackAssistantThreadContext).not.toHaveBeenCalled();
    expect(harness.setSlackAssistantSuggestedPrompts).not.toHaveBeenCalled();
  });
});
