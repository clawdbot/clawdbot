import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const { messageQueueMock, messageAllowMock } = vi.hoisted(() => ({
  messageQueueMock: vi.fn(),
  messageAllowMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => messageQueueMock(...args),
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => messageQueueMock(...args),
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => messageAllowMock(...args),
}));

let registerSlackMessageEvents: typeof import("./messages.js").registerSlackMessageEvents;

type MessageHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;
type RegisteredEventName = "message" | "app_mention";

type MessageCase = {
  overrides?: SlackSystemEventTestOverrides;
  event?: Record<string, unknown>;
  body?: unknown;
};

function createHandlers(eventName: RegisteredEventName, overrides?: SlackSystemEventTestOverrides) {
  const harness = createSlackSystemEventTestHarness(overrides);
  const handleSlackMessage = vi.fn(async () => {});
  registerSlackMessageEvents({
    ctx: harness.ctx,
    handleSlackMessage,
  });
  return {
    handler: harness.getHandler(eventName) as MessageHandler | null,
    handleSlackMessage,
  };
}

function requireMessageHandler(handler: MessageHandler | null): MessageHandler {
  if (!handler) {
    throw new Error("expected Slack message event handler");
  }
  return handler;
}

function resetMessageMocks(): void {
  messageQueueMock.mockClear();
  messageAllowMock.mockReset().mockResolvedValue([]);
}

beforeAll(async () => {
  ({ registerSlackMessageEvents } = await import("./messages.js"));
});

beforeEach(() => {
  resetMessageMocks();
});

function makeChangedEvent(overrides?: { channel?: string; user?: string }) {
  const user = overrides?.user ?? "U1";
  return {
    type: "message",
    subtype: "message_changed",
    channel: overrides?.channel ?? "D1",
    message: { ts: "123.456", user },
    previous_message: { ts: "123.450", user },
    event_ts: "123.456",
  };
}

function makeAssistantChangedEvent(overrides?: { user?: string }) {
  const user = overrides?.user ?? "UREAL123";
  return {
    type: "message",
    subtype: "message_changed",
    channel: "D1",
    channel_type: "im",
    user: "U_BOT",
    message: {
      ts: "123.456",
      thread_ts: "123.000",
      user: "U_BOT",
      text: "assistant wrapped user text",
      metadata: { event_payload: { user } },
    },
    previous_message: { ts: "123.456", user: "U_BOT" },
    event_ts: "123.789",
  };
}

function makeDeletedEvent(overrides?: { channel?: string; user?: string }) {
  return {
    type: "message",
    subtype: "message_deleted",
    channel: overrides?.channel ?? "D1",
    deleted_ts: "123.456",
    previous_message: {
      ts: "123.450",
      user: overrides?.user ?? "U1",
    },
    event_ts: "123.456",
  };
}

function makeThreadBroadcastEvent(overrides?: { channel?: string; user?: string }) {
  const user = overrides?.user ?? "U1";
  return {
    type: "message",
    subtype: "thread_broadcast",
    channel: overrides?.channel ?? "D1",
    user,
    message: { ts: "123.456", user },
    event_ts: "123.456",
  };
}

function makeAppMentionEvent(overrides?: {
  channel?: string;
  channelType?: "channel" | "group" | "im" | "mpim";
  ts?: string;
}) {
  return {
    type: "app_mention",
    channel: overrides?.channel ?? "C123",
    channel_type: overrides?.channelType ?? "channel",
    user: "U1",
    text: "<@U_BOT> hello",
    ts: overrides?.ts ?? "123.456",
  };
}

async function invokeRegisteredHandler(input: {
  eventName: RegisteredEventName;
  overrides?: SlackSystemEventTestOverrides;
  event: Record<string, unknown>;
  body?: unknown;
}) {
  const { handler, handleSlackMessage } = createHandlers(input.eventName, input.overrides);
  await requireMessageHandler(handler)({
    event: input.event,
    body: input.body ?? {},
  });
  return { handleSlackMessage };
}

async function runMessageCase(input: MessageCase = {}): Promise<void> {
  const { handler } = createHandlers("message", input.overrides);
  await requireMessageHandler(handler)({
    event: (input.event ?? makeChangedEvent()) as Record<string, unknown>,
    body: input.body ?? {},
  });
}

describe("registerSlackMessageEvents", () => {
  const cases: Array<{ name: string; input: MessageCase; calls: number }> = [
    {
      name: "enqueues message_changed system events when dmPolicy is open",
      input: { overrides: { dmPolicy: "open" }, event: makeChangedEvent() },
      calls: 1,
    },
    {
      name: "blocks message_changed system events when dmPolicy is disabled",
      input: { overrides: { dmPolicy: "disabled" }, event: makeChangedEvent() },
      calls: 0,
    },
    {
      name: "blocks message_changed system events for unauthorized senders in allowlist mode",
      input: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: makeChangedEvent({ user: "U1" }),
      },
      calls: 0,
    },
    {
      name: "blocks message_deleted system events for users outside channel users allowlist",
      input: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"],
        },
        event: makeDeletedEvent({ channel: "C1", user: "U_ATTACKER" }),
      },
      calls: 0,
    },
  ];
  it.each(cases)("$name", async ({ input, calls }) => {
    await runMessageCase(input);
    expect(messageQueueMock).toHaveBeenCalledTimes(calls);
  });

  it("passes regular message events to the message handler", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "message",
      overrides: { dmPolicy: "open" },
      event: {
        type: "message",
        channel: "D1",
        user: "U1",
        text: "hello",
        ts: "123.456",
      },
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("passes thread_broadcast events to the message handler", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "message",
      overrides: { dmPolicy: "open" },
      event: makeThreadBroadcastEvent({ channel: "C1", user: "U1" }),
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    const call = handleSlackMessage.mock.calls[0] as unknown as
      | [{ subtype?: string; channel?: string; user?: string }, { source?: string }]
      | undefined;
    expect(call?.[0]?.subtype).toBe("thread_broadcast");
    expect(call?.[0]?.channel).toBe("C1");
    expect(call?.[0]?.user).toBe("U1");
    expect(call?.[1]).toEqual({ source: "message" });
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("rehydrates assistant DM message_changed events with a metadata user as inbound messages", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "message",
      overrides: { dmPolicy: "open" },
      event: makeAssistantChangedEvent(),
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    const call = handleSlackMessage.mock.calls[0] as unknown as
      | [
          {
            channel?: string;
            channel_type?: string;
            user?: string;
            text?: string;
            ts?: string;
            thread_ts?: string;
          },
          { source?: string },
        ]
      | undefined;
    const message = call?.[0];
    expect(message?.channel).toBe("D1");
    expect(message?.channel_type).toBe("im");
    expect(message?.user).toBe("UREAL123");
    expect(message?.text).toBe("assistant wrapped user text");
    expect(message?.ts).toBe("123.456");
    expect(message?.thread_ts).toBe("123.000");
    expect(call?.[1]).toEqual({ source: "message" });
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("drops self-authored message_changed events without assistant sender metadata", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "message",
      overrides: { dmPolicy: "open" },
      event: {
        ...makeAssistantChangedEvent(),
        message: {
          ts: "123.456",
          user: "U_BOT",
          text: "preview edit",
        },
      },
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("drops self-authored message_changed events that only include block user IDs", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "message",
      overrides: { dmPolicy: "open" },
      event: {
        ...makeAssistantChangedEvent(),
        message: {
          ts: "123.456",
          user: "U_BOT",
          text: "preview edit with mention",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "user", user_id: "UREAL123" }],
                },
              ],
            },
          ],
        },
      },
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("handles channel and group messages via the unified message handler", async () => {
    const { handler, handleSlackMessage } = createHandlers("message", {
      dmPolicy: "open",
      channelType: "channel",
    });

    const messageHandler = requireMessageHandler(handler);

    // channel_type distinguishes the source; all arrive as event type "message"
    const channelMessage = {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "hello channel",
      ts: "123.100",
    };
    await messageHandler({ event: channelMessage, body: {} });
    await messageHandler({
      event: {
        ...channelMessage,
        channel_type: "group",
        channel: "G1",
        ts: "123.200",
      },
      body: {},
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(2);
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("applies subtype system-event handling for channel messages", async () => {
    // message_changed events from channels arrive via the generic "message"
    // handler with channel_type:"channel" — not a separate event type.
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "message",
      overrides: {
        dmPolicy: "open",
        channelType: "channel",
      },
      event: {
        ...makeChangedEvent({ channel: "C1", user: "U1" }),
        channel_type: "channel",
      },
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(messageQueueMock).toHaveBeenCalledTimes(1);
  });

  it("skips app_mention events for DM channel ids even with contradictory channel_type", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "app_mention",
      overrides: { dmPolicy: "open" },
      event: makeAppMentionEvent({ channel: "D123", channelType: "channel" }),
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
  });

  it("routes app_mention events from channels to the message handler", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "app_mention",
      overrides: { dmPolicy: "open" },
      event: makeAppMentionEvent({ channel: "C123", channelType: "channel", ts: "123.789" }),
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
  });
});
