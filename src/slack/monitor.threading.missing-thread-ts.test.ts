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

vi.mock("./resolve-channels.js", () => ({
  resolveSlackChannelAllowlist: async ({ entries }: { entries: string[] }) =>
    entries.map((input) => ({ input, resolved: false })),
}));

vi.mock("./resolve-users.js", () => ({
  resolveSlackUserAllowlist: async ({ entries }: { entries: string[] }) =>
    entries.map((input) => ({ input, resolved: false })),
}));

vi.mock("./send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/moltbot-sessions.json"),
  updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
  resolveSessionKey: vi.fn(),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@slack/bolt", () => {
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  (globalThis as { __slackHandlers?: typeof handlers }).__slackHandlers = handlers;
  const client = {
    auth: { test: vi.fn().mockResolvedValue({ user_id: "bot-user" }) },
    conversations: {
      info: vi.fn().mockResolvedValue({
        channel: { name: "general", is_channel: true },
      }),
      replies: vi.fn().mockResolvedValue({ messages: [] }),
      history: vi.fn().mockResolvedValue({ messages: [] }),
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
  class HTTPReceiver {
    requestListener = vi.fn();
  }
  return { App, HTTPReceiver, default: { App, HTTPReceiver } };
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
  getSlackHandlers()?.clear();
  config = {
    messages: { responsePrefix: "PFX" },
    channels: {
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        groupPolicy: "open",
        channels: { C1: { allow: true, requireMention: false } },
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

describe("monitorSlackProvider threading", () => {
  it("recovers missing thread_ts when parent_user_id is present", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });

    const client = getSlackClient();
    if (!client) throw new Error("Slack client not registered");
    const conversations = client.conversations as {
      history: ReturnType<typeof vi.fn>;
    };
    conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "456", thread_ts: "111.222" }],
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
        ts: "456",
        parent_user_id: "U2",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "111.222" });
  });
});
