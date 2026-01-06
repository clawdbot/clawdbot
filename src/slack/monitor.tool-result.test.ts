import { beforeEach, describe, expect, it, vi } from "vitest";

import { monitorSlackProvider } from "./monitor.js";

const sendMock = vi.fn();
const replyMock = vi.fn();
const updateLastRouteMock = vi.fn();
let config: Record<string, unknown> = {};
let conversationsInfoResponse: Record<string, unknown> = {
  channel: { name: "dm", is_im: true },
};
const getSlackHandlers = () =>
  (
    globalThis as {
      __slackHandlers?: Map<string, (args: unknown) => Promise<void>>;
    }
  ).__slackHandlers;

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => config,
  };
});

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: unknown[]) => replyMock(...args),
}));

vi.mock("./send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/clawdbot-sessions.json"),
  updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
  resolveSessionKey: vi.fn(),
}));

vi.mock("@slack/bolt", () => {
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  (globalThis as { __slackHandlers?: typeof handlers }).__slackHandlers =
    handlers;
  class App {
    client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: "bot-user" }) },
      conversations: {
        info: vi.fn().mockImplementation(() =>
          Promise.resolve(conversationsInfoResponse),
        ),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { profile: { display_name: "Ada" } },
        }),
      },
    };
    event(name: string, handler: (args: unknown) => Promise<void>) {
      handlers.set(name, handler);
    }
    command() {
      /* no-op */
    }
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
  }
  return { default: { App } };
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForEvent(name: string) {
  for (let i = 0; i < 10; i += 1) {
    if (getSlackHandlers()?.has(name)) return;
    await flush();
  }
}

beforeEach(() => {
  config = {
    messages: { responsePrefix: "PFX" },
    slack: { dm: { enabled: true }, groupDm: { enabled: false } },
    routing: { allowFrom: [] },
  };
  conversationsInfoResponse = { channel: { name: "dm", is_im: true } };
  sendMock.mockReset().mockResolvedValue(undefined);
  replyMock.mockReset();
  updateLastRouteMock.mockReset();
});

describe("monitorSlackProvider tool results", () => {
  it("sends tool summaries with responsePrefix", async () => {
    replyMock.mockImplementation(async (_ctx, opts) => {
      await opts?.onToolResult?.({ text: "tool update" });
      return { text: "final reply" };
    });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][1]).toBe("PFX tool update");
    expect(sendMock.mock.calls[1][1]).toBe("PFX final reply");
  });

  it("applies channel skill filters and system prompts", async () => {
    conversationsInfoResponse = {
      channel: {
        name: "support",
        is_channel: true,
        topic: { value: "Support queue" },
        purpose: { value: "Handle customers" },
      },
    };
    config = {
      slack: {
        dm: { enabled: true },
        channels: {
          C1: {
            autoReply: true,
            skills: ["customer-support"],
            users: ["U1"],
            systemPrompt: "Be kind.",
          },
        },
      },
    };
    replyMock.mockResolvedValue({ text: "final reply" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "124",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    const [ctx, opts] = replyMock.mock.calls[0] ?? [];
    expect(opts?.skillFilter).toEqual(["customer-support"]);
    expect(ctx?.GroupSystemPrompt).toContain("Channel description:");
    expect(ctx?.GroupSystemPrompt).toContain("Support queue");
    expect(ctx?.GroupSystemPrompt).toContain("Be kind.");
  });

  it("lets channel config override wildcard disables", async () => {
    conversationsInfoResponse = {
      channel: {
        name: "support",
        is_channel: true,
      },
    };
    config = {
      slack: {
        channels: {
          "*": { enabled: false },
          C1: { allow: true, autoReply: true },
        },
      },
    };
    replyMock.mockResolvedValue({ text: "final reply" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "125",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
  });
});
