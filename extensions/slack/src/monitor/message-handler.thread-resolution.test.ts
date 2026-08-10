// Slack tests cover message handler thread-resolution integration behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMock = vi.fn(async (_entry: unknown) => {});

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    createChannelInboundDebouncer: () => ({
      debounceMs: 10,
      debouncer: {
        enqueue: enqueueMock,
        flushKey: async () => {},
        cancelKey: () => false,
        drain: async () => {},
      },
    }),
  };
});

const { createSlackMessageHandler } = await import("./message-handler.js");

describe("Slack message handler thread resolution", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
  });

  it("shares Enterprise history lookups per listener client while isolating replacement clients", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [{ ts: "1709000000.000200", thread_ts: "1709000000.000100" }],
    });
    const replacementHistory = vi.fn().mockResolvedValue({
      messages: [{ ts: "1709000000.000200", thread_ts: "1709000000.000100" }],
    });
    const client = { conversations: { history } };
    const replacementClient = { conversations: { history: replacementHistory } };
    const handler = createSlackMessageHandler({
      ctx: {
        cfg: {},
        accountId: "default",
        app: { client: { conversations: { history: vi.fn() } } },
        runtime: {},
        rememberSlackChannelType: () => {},
      } as never,
      account: { accountId: "default" } as never,
    });
    const message = {
      type: "message",
      channel: "C111",
      parent_user_id: "U222",
      user: "U111",
      ts: "1709000000.000200",
      text: "thread reply",
    } as never;

    await handler(message, {
      source: "message",
      eventScope: { teamId: "T111", client } as never,
    });
    await handler(message, {
      source: "app_mention",
      eventScope: { teamId: "T111", client } as never,
    });

    expect(history).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(enqueueMock.mock.calls[0]?.[0]).toMatchObject({
      message: { thread_ts: "1709000000.000100" },
    });
    expect(enqueueMock.mock.calls[1]?.[0]).toMatchObject({
      message: { thread_ts: "1709000000.000100" },
    });

    await handler(message, {
      source: "message",
      eventScope: { teamId: "T111", client: replacementClient } as never,
    });

    expect(history).toHaveBeenCalledTimes(1);
    expect(replacementHistory).toHaveBeenCalledTimes(1);
  });
});
