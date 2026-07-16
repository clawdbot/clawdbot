import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const messageQueueMock = vi.fn();
const messageAllowMock = vi.fn();

async function createChannelRuntimeMock() {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => messageQueueMock(...args),
  };
}

vi.mock("openclaw/plugin-sdk/infra-runtime", createChannelRuntimeMock);
vi.mock("openclaw/plugin-sdk/infra-runtime.js", createChannelRuntimeMock);

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => messageAllowMock(...args),
  };
});

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
  expect(handler).toBeTruthy();
  await handler!({
    event: input.event,
    body: input.body ?? {},
  });
  return { handleSlackMessage };
}

async function runMessageCase(input: MessageCase = {}): Promise<void> {
  const { handler } = createHandlers("message", input.overrides);
  expect(handler).toBeTruthy();
  await handler!({
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
    {
      name: "blocks thread_broadcast system events without an authenticated sender",
      input: {
        overrides: { dmPolicy: "open" },
        event: {
          ...makeThreadBroadcastEvent(),
          user: undefined,
          message: { ts: "123.456" },
        },
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

  it("handles channel and group messages via the unified message handler", async () => {
    const { handler, handleSlackMessage } = createHandlers("message", {
      dmPolicy: "open",
      channelType: "channel",
    });

    expect(handler).toBeTruthy();

    // channel_type distinguishes the source; all arrive as event type "message"
    const channelMessage = {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "hello channel",
      ts: "123.100",
    };
    await handler!({ event: channelMessage, body: {} });
    await handler!({
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
