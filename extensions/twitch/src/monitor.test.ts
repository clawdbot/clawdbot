import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_TWITCH_TEST_ACCOUNT } from "./test-fixtures.js";
import type { TwitchChatMessage } from "./types.js";

const mocks = vi.hoisted(() => ({
  checkAccess: vi.fn(async () => ({ allowed: true })),
  createIngress: vi.fn(),
  getClient: vi.fn(async () => ({})),
  getRuntime: vi.fn(),
  ingressStart: vi.fn(),
  ingressStop: vi.fn(async () => undefined),
  onMessage: vi.fn(),
  runInbound: vi.fn(),
  sendMessage: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("./access-control.js", () => ({
  checkTwitchAccessControl: mocks.checkAccess,
}));

vi.mock("./client-manager-registry.js", () => ({
  getOrCreateClientManager: () => ({
    getClient: mocks.getClient,
    onMessage: mocks.onMessage,
    sendMessage: mocks.sendMessage,
  }),
}));

vi.mock("./runtime.js", () => ({
  getTwitchRuntime: mocks.getRuntime,
}));

vi.mock("./twitch-ingress.js", () => ({
  createTwitchIngress: mocks.createIngress,
}));

import { monitorTwitchProvider } from "./monitor.js";

type InboundRunInput = {
  raw: TwitchChatMessage;
  adapter: {
    ingest: (message: TwitchChatMessage) => unknown;
    resolveTurn: (input: unknown) => Promise<{
      delivery: {
        deliver: (payload: { text: string }) => Promise<unknown>;
      };
    }>;
  };
};

describe("monitorTwitchProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({});
    mocks.sendMessage.mockResolvedValue({ ok: true, messageId: "message-id" });
    mocks.createIngress.mockImplementation(
      (options: {
        deliver: (
          message: TwitchChatMessage,
          lifecycle: {
            admission: "exclusive";
            abortSignal: AbortSignal;
            onAdopted: () => Promise<void>;
            onDeferred: () => void;
            onAbandoned: () => Promise<void>;
          },
        ) => Promise<void>;
      }) => ({
        accept: async (message: TwitchChatMessage) => {
          await options.deliver(message, {
            admission: "exclusive",
            abortSignal: new AbortController().signal,
            onAdopted: async () => undefined,
            onDeferred: () => undefined,
            onAbandoned: async () => undefined,
          });
        },
        start: mocks.ingressStart,
        stop: mocks.ingressStop,
      }),
    );
    mocks.runInbound.mockImplementation(async (input: InboundRunInput) => {
      const ingested = input.adapter.ingest(input.raw);
      const turn = await input.adapter.resolveTurn(ingested);
      await turn.delivery.deliver({ text: "**Hello** Twitch" });
    });
    mocks.getRuntime.mockReturnValue({
      logging: {
        getChildLogger: () => ({
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
        shouldLogVerbose: () => false,
      },
      channel: {
        inbound: {
          run: mocks.runInbound,
          buildContext: vi.fn(() => ({})),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:twitch:group:testchannel",
          })),
        },
        reply: {
          formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          recordInboundSession: vi.fn(),
        },
        text: {
          resolveMarkdownTableMode: vi.fn(() => "off"),
        },
      },
    });
  });

  it("delivers fallback replies through the monitor boundary", async () => {
    let onMessage: ((message: TwitchChatMessage) => void) | undefined;
    mocks.onMessage.mockImplementation(
      (_account: unknown, handler: (message: TwitchChatMessage) => void) => {
        onMessage = handler;
        return mocks.unregister;
      },
    );
    const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "oauth:test-token" };
    const monitor = await monitorTwitchProvider({
      account,
      accountId: "default",
      config: {},
      runtime: {},
      abortSignal: new AbortController().signal,
    });

    onMessage?.({
      id: "message-1",
      username: "viewer",
      userId: "viewer-1",
      message: "hello bot",
      channel: "testchannel",
    });

    await vi.waitFor(() => {
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        account,
        "testchannel",
        "Hello Twitch",
        {},
        "default",
      );
    });

    await monitor.stop();
    expect(mocks.unregister).toHaveBeenCalledOnce();
    expect(mocks.ingressStop).toHaveBeenCalledOnce();
  });
});
