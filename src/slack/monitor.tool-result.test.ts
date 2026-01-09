import { beforeEach, describe, expect, it, vi } from "vitest";

import { monitorSlackProvider } from "./monitor.js";

const sendMock = vi.fn();
const replyMock = vi.fn();
const updateLastRouteMock = vi.fn();
const reactMock = vi.fn();
let config: Record<string, unknown> = {};
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();
const getSlackHandlers = () =>
  (
    globalThis as {
      __slackHandlers?: Map<string, (args: unknown) => Promise<void>>;
    }
  ).__slackHandlers;
const getSlackClient = () =>
  (globalThis as { __slackClient?: Record<string, unknown> }).__slackClient;

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

vi.mock("../pairing/pairing-store.js", () => ({
  readProviderAllowFromStore: (...args: unknown[]) =>
    readAllowFromStoreMock(...args),
  upsertProviderPairingRequest: (...args: unknown[]) =>
    upsertPairingRequestMock(...args),
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
  const client = {
    auth: { test: vi.fn().mockResolvedValue({ user_id: "bot-user" }) },
    conversations: {
      info: vi.fn().mockResolvedValue({
        channel: { name: "dm", is_im: true },
      }),
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
    users: {
      info: vi.fn().mockResolvedValue({
        user: { profile: { display_name: "Ada" } },
      }),
    },
    assistant: {
      threads: {
        setStatus: vi.fn().mockResolvedValue({ ok: true }),
      },
    },
    reactions: {
      add: (...args: unknown[]) => reactMock(...args),
    },
  };
  (globalThis as { __slackClient?: typeof client }).__slackClient = client;
  class App {
    client = client;
    event(name: string, handler: (args: unknown) => Promise<void>) {
      handlers.set(name, handler);
    }
    command() {
      /* no-op */
    }
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
  }
  return { App, default: { App } };
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
    messages: {
      responsePrefix: "PFX",
      ackReaction: "👀",
      ackReactionScope: "group-mentions",
    },
    slack: { dm: { enabled: true, policy: "open", allowFrom: ["*"] } },
  };
  sendMock.mockReset().mockResolvedValue(undefined);
  replyMock.mockReset();
  updateLastRouteMock.mockReset();
  reactMock.mockReset();
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock
    .mockReset()
    .mockResolvedValue({ code: "PAIRCODE", created: true });
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

  it("derives responsePrefix from routed agent identity when unset", async () => {
    config = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            identity: { name: "Mainbot", theme: "space lobster", emoji: "🦞" },
          },
          {
            id: "rich",
            identity: { name: "Richbot", theme: "lion bot", emoji: "🦁" },
          },
        ],
      },
      bindings: [
        {
          agentId: "rich",
          match: { provider: "slack", peer: { kind: "dm", id: "U1" } },
        },
      ],
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      slack: { dm: { enabled: true, policy: "open", allowFrom: ["*"] } },
    };

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
    expect(sendMock.mock.calls[0][1]).toBe("[Richbot] tool update");
    expect(sendMock.mock.calls[1][1]).toBe("[Richbot] final reply");
  });

  it("updates assistant thread status when replies start", async () => {
    replyMock.mockImplementation(async (_ctx, opts) => {
      await opts?.onReplyStart?.();
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

    const client = getSlackClient() as {
      assistant?: { threads?: { setStatus?: ReturnType<typeof vi.fn> } };
    };
    const setStatus = client.assistant?.threads?.setStatus;
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenNthCalledWith(1, {
      token: "bot-token",
      channel_id: "C1",
      thread_ts: "123",
      status: "is typing...",
    });
    expect(setStatus).toHaveBeenNthCalledWith(2, {
      token: "bot-token",
      channel_id: "C1",
      thread_ts: "123",
      status: "",
    });
  });

  it("accepts channel messages when mentionPatterns match", async () => {
    config = {
      messages: {
        responsePrefix: "PFX",
        groupChat: { mentionPatterns: ["\\bclawd\\b"] },
      },
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        channels: { C1: { allow: true, requireMention: true } },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

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
        text: "clawd: hello",
        ts: "123",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0].WasMentioned).toBe(true);
  });

  it("treats control commands as mentions for group bypass", async () => {
    replyMock.mockResolvedValue({ text: "ok" });

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
        text: "/elevated off",
        ts: "123",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0].WasMentioned).toBe(true);
  });

  it("threads replies when incoming message is in a thread", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        replyToMode: "off",
      },
    };

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
        thread_ts: "456",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "456" });
  });

  it("threads top-level replies when replyToMode is all", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        replyToMode: "all",
      },
    };

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

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "123" });
  });

  it("treats parent_user_id as a thread reply even when thread_ts matches ts", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });

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
        thread_ts: "123",
        parent_user_id: "U2",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = replyMock.mock.calls[0]?.[0] as {
      SessionKey?: string;
      ParentSessionKey?: string;
    };
    expect(ctx.SessionKey).toBe("agent:main:main:thread:123");
    expect(ctx.ParentSessionKey).toBe("agent:main:main");
  });

  it("forks thread sessions and injects starter context", async () => {
    replyMock.mockResolvedValue({ text: "ok" });

    const client = getSlackClient();
    if (client?.conversations?.info) {
      client.conversations.info.mockResolvedValue({
        channel: { name: "general", is_channel: true },
      });
    }
    if (client?.conversations?.replies) {
      client.conversations.replies.mockResolvedValue({
        messages: [{ text: "starter message", user: "U2", ts: "111.222" }],
      });
    }

    config = {
      messages: { responsePrefix: "PFX" },
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        channels: { C1: { allow: true, requireMention: false } },
      },
    };

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
        text: "thread reply",
        ts: "123.456",
        thread_ts: "111.222",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = replyMock.mock.calls[0]?.[0] as {
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    };
    expect(ctx.SessionKey).toBe("agent:main:slack:channel:C1:thread:111.222");
    expect(ctx.ParentSessionKey).toBe("agent:main:slack:channel:C1");
    expect(ctx.ThreadStarterBody).toContain("starter message");
    expect(ctx.ThreadLabel).toContain("Slack thread #general");
  });

  it("scopes thread session keys to the routed agent", async () => {
    replyMock.mockResolvedValue({ text: "ok" });
    config = {
      messages: { responsePrefix: "PFX" },
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        channels: { C1: { allow: true, requireMention: false } },
      },
      bindings: [
        { agentId: "support", match: { provider: "slack", teamId: "T1" } },
      ],
    };

    const client = getSlackClient();
    if (client?.auth?.test) {
      client.auth.test.mockResolvedValue({
        user_id: "bot-user",
        team_id: "T1",
      });
    }
    if (client?.conversations?.info) {
      client.conversations.info.mockResolvedValue({
        channel: { name: "general", is_channel: true },
      });
    }

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
        text: "thread reply",
        ts: "123.456",
        thread_ts: "111.222",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = replyMock.mock.calls[0]?.[0] as {
      SessionKey?: string;
      ParentSessionKey?: string;
    };
    expect(ctx.SessionKey).toBe(
      "agent:support:slack:channel:C1:thread:111.222",
    );
    expect(ctx.ParentSessionKey).toBe("agent:support:slack:channel:C1");
  });

  it("keeps replies in channel root when message is not threaded", async () => {
    replyMock.mockResolvedValue({ text: "root reply" });
    config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        replyToMode: "first",
      },
    };

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
        ts: "789",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: undefined });
  });

  it("forces thread replies when replyToId is set", async () => {
    replyMock.mockResolvedValue({ text: "forced reply", replyToId: "555" });
    config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        replyToMode: "off",
      },
    };

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
        ts: "789",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "555" });
  });

  it("reacts to mention-gated room messages when ackReaction is enabled", async () => {
    replyMock.mockResolvedValue(undefined);
    const client = getSlackClient();
    if (!client) throw new Error("Slack client not registered");
    const conversations = client.conversations as {
      info: ReturnType<typeof vi.fn>;
    };
    conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
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
        text: "<@bot-user> hello",
        ts: "456",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(reactMock).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "456",
      name: "👀",
    });
  });

  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    config = {
      ...config,
      slack: { dm: { enabled: true, policy: "pairing", allowFrom: [] } },
    };

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

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      "Your Slack user id: U1",
    );
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      "Pairing code: PAIRCODE",
    );
  });

  it("does not resend pairing code when a request is already pending", async () => {
    config = {
      ...config,
      slack: { dm: { enabled: true, policy: "pairing", allowFrom: [] } },
    };
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    const baseEvent = {
      type: "message",
      user: "U1",
      text: "hello",
      ts: "123",
      channel: "C1",
      channel_type: "im",
    };

    await handler({ event: baseEvent });
    await handler({ event: { ...baseEvent, ts: "124", text: "hello again" } });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
