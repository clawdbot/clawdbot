import { join } from "node:path";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelInboundEventRunnerParams } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwitchConfigSchema } from "./config-schema.js";
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
        deliver: (payload: ReplyPayload) => Promise<{ visibleReplySent: boolean }>;
        onDelivered: (
          payload: ReplyPayload,
          info: { kind: "final" },
          result: { visibleReplySent: boolean },
        ) => void;
      };
    }>;
  };
};

describe("monitorTwitchProvider", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

  it.each([
    { name: "single-account root", multi: false, override: undefined, expected: "[root] reply" },
    { name: "multi-account root", multi: true, override: undefined, expected: "[root] reply" },
    { name: "account override", multi: true, override: "[account]", expected: "[account] reply" },
    { name: "empty override", multi: true, override: "", expected: "reply" },
  ])(
    "delivers $name prefixes through the shared dispatcher",
    async ({ name, multi, override, expected }) => {
      const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "oauth:test-token" };
      const channelConfig = multi
        ? {
            responsePrefix: "[root]",
            accounts: { default: { ...account, responsePrefix: override } },
          }
        : { ...account, responsePrefix: "[root]" };
      expect(
        validateJsonSchemaValue({
          cacheKey: "twitch.monitor-prefix",
          schema: buildChannelConfigSchema(TwitchConfigSchema).schema,
          value: channelConfig,
        }),
      ).toMatchObject({ ok: true });
      const config: OpenClawConfig = {
        session: { store: join(tempDirs.make("twitch-prefix-"), "sessions.json") },
        messages: { responsePrefix: "[global]" },
        channels: { twitch: channelConfig },
      };
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
        "openclaw/plugin-sdk/channel-inbound",
      );
      mocks.getRuntime().channel.inbound.buildContext = actual.buildChannelInboundEventContext;
      mocks.runInbound.mockImplementation(
        (input: ChannelInboundEventRunnerParams<TwitchChatMessage>) =>
          actual.runChannelInboundEvent({
            ...input,
            // This observes native output, not ingress or delivery queue persistence.
            turnAdoptionLifecycle: undefined,
            adapter: {
              ...input.adapter,
              resolveTurn: async (...args) => {
                const turn = await input.adapter.resolveTurn(...args);
                if (!("delivery" in turn)) {
                  throw new Error("Expected a reply delivery turn");
                }
                return {
                  ...turn,
                  delivery: { ...turn.delivery, durable: false },
                  replyResolver: async () => ({ text: "reply" }),
                };
              },
            },
          }),
      );
      mocks.onMessage.mockReturnValue(mocks.unregister);
      const runtimeError = vi.fn();
      const monitor = await monitorTwitchProvider({
        account,
        accountId: "default",
        config,
        runtime: { error: runtimeError },
        abortSignal: new AbortController().signal,
      });
      try {
        const onMessage = mocks.onMessage.mock.calls[0]?.[1];
        onMessage({
          id: `prefix-${name}`,
          username: "viewer",
          userId: "viewer-1",
          message: "hello bot",
          channel: "testchannel",
        });
        await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce());
        expect(mocks.sendMessage).toHaveBeenCalledWith(
          account,
          "testchannel",
          expected,
          config,
          "default",
        );
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    },
  );

  it.each<{
    name: string;
    payload: ReplyPayload;
    expectedText?: string;
    expectedVisible: boolean;
    providerError?: string;
    expectedError?: string;
  }>([
    {
      name: "plain Markdown text",
      payload: { text: "**Hello** Twitch" },
      expectedText: "Hello Twitch",
      expectedVisible: true,
    },
    {
      name: "caption with a legacy media URL",
      payload: { text: "Check this:", mediaUrl: "https://example.com/image.png" },
      expectedText: "Check this: https://example.com/image.png",
      expectedVisible: true,
    },
    {
      name: "caption with every attachment URL",
      payload: {
        text: "Files attached:",
        mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
      },
      expectedText: "Files attached: https://example.com/one.png https://example.com/two.png",
      expectedVisible: true,
    },
    {
      name: "media-only reply",
      payload: { mediaUrl: "https://example.com/image.png" },
      expectedText: "https://example.com/image.png",
      expectedVisible: true,
    },
    {
      name: "empty reply",
      payload: { text: "" },
      expectedVisible: false,
      expectedError: "No text to send in reply payload",
    },
    {
      name: "provider send failure",
      payload: { text: "Hello Twitch" },
      expectedText: "Hello Twitch",
      expectedVisible: false,
      providerError: "provider unavailable",
      expectedError: "Failed to send reply: Error: provider unavailable",
    },
  ])(
    "handles $name through the public monitor boundary",
    async ({ payload, expectedText, expectedVisible, providerError, expectedError }) => {
      const settled = vi.fn();
      const statusSink = vi.fn();
      const runtimeError = vi.fn();
      if (providerError) {
        mocks.sendMessage.mockResolvedValueOnce({ ok: false, error: providerError });
      }
      mocks.runInbound.mockImplementation(async (input: InboundRunInput) => {
        const turn = await input.adapter.resolveTurn(input.adapter.ingest(input.raw));
        const result = await turn.delivery.deliver(payload);
        settled(result);
        turn.delivery.onDelivered(payload, { kind: "final" }, result);
      });
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
        runtime: { error: runtimeError },
        abortSignal: new AbortController().signal,
        statusSink,
      });

      onMessage?.({
        id: "message-1",
        username: "viewer",
        userId: "viewer-1",
        message: "hello bot",
        channel: "testchannel",
      });

      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
      expect(settled).toHaveBeenCalledWith({ visibleReplySent: expectedVisible });
      if (expectedText) {
        expect(mocks.sendMessage).toHaveBeenCalledWith(
          account,
          "testchannel",
          expectedText,
          {},
          "default",
        );
      } else {
        expect(mocks.sendMessage).not.toHaveBeenCalled();
      }
      if (expectedError) {
        expect(runtimeError).toHaveBeenCalledWith(expectedError);
      } else {
        expect(runtimeError).not.toHaveBeenCalled();
      }
      const outboundStatus = expect.objectContaining({ lastOutboundAt: expect.any(Number) });
      if (expectedVisible) {
        expect(statusSink).toHaveBeenCalledWith(outboundStatus);
      } else {
        expect(statusSink).not.toHaveBeenCalledWith(outboundStatus);
      }

      await monitor.stop();
      expect(mocks.unregister).toHaveBeenCalledOnce();
      expect(mocks.ingressStop).toHaveBeenCalledOnce();
    },
  );
});
