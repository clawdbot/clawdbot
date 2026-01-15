import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
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
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/clawdbot-sessions.json"),
  updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
  resolveSessionKey: vi.fn(),
}));

vi.mock("@slack/bolt", () => {
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  (globalThis as { __slackHandlers?: typeof handlers }).__slackHandlers = handlers;
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
  resetInboundDedupe();
  config = {
    messages: {
      responsePrefix: "PFX",
      ackReaction: "👀",
      ackReactionScope: "group-mentions",
    },
    channels: {
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        groupPolicy: "open",
      },
    },
  };
  sendMock.mockReset().mockResolvedValue(undefined);
  replyMock.mockReset();
  updateLastRouteMock.mockReset();
  reactMock.mockReset();
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
});

describe("monitorSlackProvider tool results", () => {
  it("threads top-level replies when replyToMode is all", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          replyToMode: "all",
        },
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
    expect(ctx.ParentSessionKey).toBeUndefined();
  });

  it("keeps thread parent inheritance opt-in", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });

    config = {
      messages: { responsePrefix: "PFX" },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: false } },
          thread: { inheritParent: true },
        },
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
    expect(ctx.SessionKey).toBe("agent:main:slack:channel:C1:thread:111.222");
    expect(ctx.ParentSessionKey).toBe("agent:main:slack:channel:C1");
  });

  it("injects starter context for thread replies", async () => {
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
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: false } },
        },
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
    expect(ctx.ParentSessionKey).toBeUndefined();
    expect(ctx.ThreadStarterBody).toContain("starter message");
    expect(ctx.ThreadLabel).toContain("Slack thread #general");
  });

  it("scopes thread session keys to the routed agent", async () => {
    replyMock.mockResolvedValue({ text: "ok" });
    config = {
      messages: { responsePrefix: "PFX" },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: false } },
        },
      },
      bindings: [{ agentId: "support", match: { channel: "slack", teamId: "T1" } }],
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
    expect(ctx.SessionKey).toBe("agent:support:slack:channel:C1:thread:111.222");
    expect(ctx.ParentSessionKey).toBeUndefined();
  });

  it("keeps replies in channel root when message is not threaded (replyToMode off)", async () => {
    replyMock.mockResolvedValue({ text: "root reply" });
    config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          replyToMode: "off",
        },
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

  it("threads first reply when replyToMode is first and message is not threaded", async () => {
    replyMock.mockResolvedValue({ text: "first reply" });
    config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          replyToMode: "first",
        },
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
    // First reply starts a thread under the incoming message
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "789" });
  });
});
