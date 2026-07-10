// Slack tests cover messages plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const { messageQueueMock, messageAllowMock, inboundInfoSpy } = vi.hoisted(() => ({
  messageQueueMock: vi.fn(),
  messageAllowMock: vi.fn(),
  inboundInfoSpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const makeLogger = () => {
    const logger = {
      subsystem: "test",
      isEnabled: () => true,
      trace: () => {},
      debug: () => {},
      info: inboundInfoSpy,
      warn: () => {},
      error: () => {},
      fatal: () => {},
      raw: () => {},
      child: () => logger,
    };
    return logger;
  };
  return { ...actual, createSubsystemLogger: () => makeLogger() };
});

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => messageQueueMock(...args),
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => messageQueueMock(...args),
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => messageAllowMock(...args),
}));
vi.mock("openclaw/plugin-sdk/text-chunking", () => ({
  chunkItems: <T>(items: T[]) => [items],
  markdownToIR: (text: string) => text,
  renderMarkdownIRChunksWithinLimit: (text: string) => [text],
  renderMarkdownWithMarkers: (text: string) => text,
  sanitizeAssistantVisibleText: (text: string) => text,
  stripReasoningTagsFromText: (text: string) => text,
}));

let registerSlackMessageEvents: typeof import("./messages.js").registerSlackMessageEvents;
let formatSlackInboundLogLine: typeof import("./messages.js").formatSlackInboundLogLine;

function inboundLogLines(): string[] {
  return inboundInfoSpy.mock.calls
    .map((call) => call[0])
    .filter((line): line is string => typeof line === "string" && line.startsWith("Inbound "));
}

type MessageHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
  context?: Record<string, unknown>;
  client?: object;
}) => Promise<void>;
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

function createEnterpriseHandlers(eventName: RegisteredEventName) {
  const harness = createSlackSystemEventTestHarness({ dmPolicy: "open" });
  harness.ctx.installationIdentity = {
    kind: "enterprise",
    apiAppId: "A_TEST",
    enterpriseId: "E_TEST",
  };
  const handleSlackMessage = vi.fn(async () => {});
  registerSlackMessageEvents({ ctx: harness.ctx, handleSlackMessage });
  return {
    handler: requireMessageHandler(harness.getHandler(eventName) as MessageHandler | null),
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
  ({ registerSlackMessageEvents, formatSlackInboundLogLine } = await import("./messages.js"));
});

beforeEach(() => {
  resetMessageMocks();
  inboundInfoSpy.mockClear();
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
      blocks: [
        {
          type: "data_visualization",
          title: "Latency",
          chart: {
            type: "line",
            series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
            axis_config: { categories: ["Mon"] },
          },
        },
      ],
      metadata: { event_payload: { user } },
      assistant_thread: {
        channel_id: "D1",
        thread_ts: "123.000",
        context: {
          channel_id: "C123",
          team_id: "T123",
        },
      },
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
  it("accepts two org workspaces and preserves each listener scope", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("message");
    const clients = [{ id: "one" }, { id: "two" }];
    for (const [index, teamId] of ["T111", "T222"].entries()) {
      await handler({
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U123",
          text: "hello",
          ts: `123.${index}`,
        },
        body: { api_app_id: "A_TEST" },
        context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId },
        client: clients[index],
      });
    }

    expect(handleSlackMessage).toHaveBeenCalledTimes(2);
    const calls = handleSlackMessage.mock.calls as unknown as Array<
      [unknown, { awaitDispatch?: boolean; eventScope?: unknown }]
    >;
    expect(calls[0]?.[1]).toMatchObject({
      awaitDispatch: true,
      eventScope: { teamId: "T111", client: clients[0] },
    });
    expect(calls[1]?.[1]).toMatchObject({
      awaitDispatch: true,
      eventScope: { teamId: "T222", client: clients[1] },
    });
  });

  it("passes enterprise file_share messages to the media-aware handler", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("message");
    const client = { id: "listener-client" };
    await handler({
      event: {
        type: "message",
        subtype: "file_share",
        channel: "C123",
        channel_type: "channel",
        user: "U123",
        text: "see attachment",
        files: [{ id: "F123", url_private: "https://files.slack.com/file" }],
        ts: "123.456",
      },
      body: { api_app_id: "A_TEST" },
      context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
      client,
    });

    expect(handleSlackMessage).toHaveBeenCalledOnce();
    expect(handleSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: "file_share",
        files: [{ id: "F123", url_private: "https://files.slack.com/file" }],
      }),
      expect.objectContaining({
        source: "message",
        awaitDispatch: true,
        eventScope: expect.objectContaining({ teamId: "T111", client }),
      }),
    );
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "file_share with bot_id",
      event: {
        type: "message",
        subtype: "file_share",
        bot_id: "B_OTHER",
        channel: "C123",
        channel_type: "channel",
        text: "bot attachment",
        files: [{ id: "F123", url_private: "https://files.slack.com/file" }],
        ts: "123.456",
      },
    },
    {
      name: "bot_message without bot_id",
      event: {
        type: "message",
        subtype: "bot_message",
        channel: "C123",
        channel_type: "channel",
        text: "bot text",
        ts: "123.456",
      },
    },
  ])("drops enterprise bot-authored $name events before dispatch", async ({ event }) => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("message");
    await handler({
      event,
      body: { api_app_id: "A_TEST" },
      context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
      client: {},
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("drops bot-authored enterprise app_mention events before dispatch", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("app_mention");
    await handler({
      event: { ...makeAppMentionEvent(), bot_id: "B_OTHER" },
      body: { api_app_id: "A_TEST" },
      context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
      client: {},
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(inboundLogLines()).toEqual([]);
  });

  it("drops unsupported enterprise message subtypes before system events or dispatch", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("message");
    await handler({
      event: makeChangedEvent({ channel: "C123", user: "U123" }),
      body: { api_app_id: "A_TEST" },
      context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
      client: {},
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

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
    const call = handleSlackMessage.mock.calls.at(0) as unknown as
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
    const call = handleSlackMessage.mock.calls.at(0) as unknown as
      | [
          {
            channel?: string;
            channel_type?: string;
            user?: string;
            text?: string;
            ts?: string;
            thread_ts?: string;
            assistant_thread?: Record<string, unknown>;
            blocks?: unknown[];
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
    expect(message?.assistant_thread).toEqual({
      channel_id: "D1",
      thread_ts: "123.000",
      context: {
        channel_id: "C123",
        team_id: "T123",
      },
    });
    expect(message?.blocks).toEqual([
      {
        type: "data_visualization",
        title: "Latency",
        chart: {
          type: "line",
          series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
          axis_config: { categories: ["Mon"] },
        },
      },
    ]);
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
    // Dropped DM app_mention (already handled via message.im) must not log a receipt.
    expect(inboundLogLines()).toEqual([]);
  });

  it("routes app_mention events from channels to the message handler", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "app_mention",
      overrides: { dmPolicy: "open" },
      event: makeAppMentionEvent({ channel: "C123", channelType: "channel", ts: "123.789" }),
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    expect(inboundLogLines()).toEqual([
      "Inbound app_mention slack:T_TEST:channel:C123:user:U1 -> bot:U_BOT (channel, 14 chars)",
    ]);
  });

  it("logs channel app_mention receipts with zero chars when text is absent", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "app_mention",
      overrides: { dmPolicy: "open" },
      event: {
        ...makeAppMentionEvent({ channel: "C123", channelType: "channel" }),
        text: undefined,
      },
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    expect(inboundLogLines()).toEqual([
      "Inbound app_mention slack:T_TEST:channel:C123:user:U1 -> bot:U_BOT (channel, 0 chars)",
    ]);
  });

  it("logs channel app_mention receipts with unknown sender when user is absent", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "app_mention",
      overrides: { dmPolicy: "open" },
      event: {
        ...makeAppMentionEvent({ channel: "C123", channelType: "channel" }),
        user: undefined,
      },
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    expect(inboundLogLines()).toEqual([
      "Inbound app_mention slack:T_TEST:channel:C123:user:unknown -> bot:U_BOT (channel, 14 chars)",
    ]);
  });

  it("formats the inbound receipt line with channel, sender, body length, and bot identity", () => {
    expect(
      formatSlackInboundLogLine({
        workspaceId: "T123",
        channelId: "C456",
        channelType: "channel",
        userId: "U789",
        botUserId: "U_BOT",
        bodyChars: 42,
      }),
    ).toBe(
      "Inbound app_mention slack:T123:channel:C456:user:U789 -> bot:U_BOT (channel, 42 chars)",
    );
  });
});
