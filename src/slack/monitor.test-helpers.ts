import { vi } from "vitest";

type SlackHandler = (args: unknown) => Promise<void>;

const slackTestState = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  sendMock: vi.fn(),
  replyMock: vi.fn(),
  updateLastRouteMock: vi.fn(),
  reactMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
}));

export const getSlackTestState = () => slackTestState;

export const getSlackHandlers = () =>
  (
    globalThis as {
      __slackHandlers?: Map<string, SlackHandler>;
    }
  ).__slackHandlers;

export const getSlackClient = () =>
  (globalThis as { __slackClient?: Record<string, unknown> }).__slackClient;

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function waitForSlackEvent(name: string) {
  for (let i = 0; i < 10; i += 1) {
    if (getSlackHandlers()?.has(name)) return;
    await flush();
  }
}

export const defaultSlackTestConfig = () => ({
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
});

export function resetSlackTestState(config: Record<string, unknown> = defaultSlackTestConfig()) {
  slackTestState.config = config;
  slackTestState.sendMock.mockReset().mockResolvedValue(undefined);
  slackTestState.replyMock.mockReset();
  slackTestState.updateLastRouteMock.mockReset();
  slackTestState.reactMock.mockReset();
  slackTestState.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  slackTestState.upsertPairingRequestMock.mockReset().mockResolvedValue({
    code: "PAIRCODE",
    created: true,
  });
  getSlackHandlers()?.clear();
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => slackTestState.config,
  };
});

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: unknown[]) => slackTestState.replyMock(...args),
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
  sendMessageSlack: (...args: unknown[]) => slackTestState.sendMock(...args),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => slackTestState.readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) =>
    slackTestState.upsertPairingRequestMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/moltbot-sessions.json"),
  updateLastRoute: (...args: unknown[]) => slackTestState.updateLastRouteMock(...args),
  resolveSessionKey: vi.fn(),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@slack/bolt", () => {
  const handlers = new Map<string, SlackHandler>();
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
      add: (...args: unknown[]) => slackTestState.reactMock(...args),
    },
  };
  (globalThis as { __slackClient?: typeof client }).__slackClient = client;
  class App {
    client = client;
    event(name: string, handler: SlackHandler) {
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
