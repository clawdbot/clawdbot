// Zalouser custom delivery tests cover the real channel lifecycle and outbound hook ordering.
import path from "node:path";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { dispatchChannelInboundTurn } from "openclaw/plugin-sdk/channel-inbound";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { sendMessageZalouserMock } from "./monitor.send.test-mocks.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { startZaloListenerMock } from "./zalo-js.test-mocks.js";
import {
  createRawZalouserMessageFromNormalized,
  withZalouserIngressTestQueue,
} from "./ingress.test-support.js";
import { monitorZalouserProvider } from "./monitor.js";
import { setZalouserRuntime } from "./runtime.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createAccount(): ResolvedZalouserAccount {
  return {
    accountId: "default",
    enabled: true,
    profile: "default",
    authenticated: true,
    config: { dmPolicy: "open", allowFrom: ["*"] },
  };
}

function createConfig(): OpenClawConfig {
  return {
    agents: { defaults: { verboseDefault: "on" } },
    channels: { zalouser: { enabled: true, dmPolicy: "open", allowFrom: ["*"] } },
    session: {
      store: path.join(tempDirs.make("openclaw-zalouser-delivery-"), "sessions.json"),
    },
  };
}

function createMessage(): ZaloInboundMessage {
  return {
    threadId: "u-sanitizer",
    isGroup: false,
    senderId: "321",
    senderName: "Bob",
    timestampMs: Date.now(),
    msgId: "dm-sanitizer",
    content: "hello",
    raw: { source: "test" },
  };
}

function installRuntime() {
  const lifecycleDispatchResults: Awaited<ReturnType<typeof dispatchChannelInboundTurn>>[] = [];
  const messageSendingHook = vi.fn(async (...args: unknown[]) => {
    const event = args[0];
    if (
      !event ||
      typeof event !== "object" ||
      !("content" in event) ||
      typeof event.content !== "string"
    ) {
      throw new Error("message_sending test hook requires string content");
    }
    return {
      content:
        event.content === "Replace me."
          ? "⚠️ 🛠️ `search repos (agent)` failed"
          : `${event.content}\n⚠️ 🛠️ \`search repos (agent)\` failed`,
    };
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "message_sending", handler: messageSendingHook }]),
  );

  type TurnPlan = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];
  const dispatch = vi.fn(async (plan: TurnPlan) => {
    const result = await dispatchChannelInboundTurn({
      ...plan,
      replyResolver: async (_ctx, options) => {
        await options?.onToolResult?.({ text: "Done." });
        await options?.onToolResult?.({ text: "Replace me." });
        return undefined;
      },
    });
    lifecycleDispatchResults.push(result);
    return result;
  });
  const buildContext = vi.fn(
    (params: Parameters<PluginRuntime["channel"]["inbound"]["buildContext"]>[0]) =>
      ({
        Body: params.message.body ?? params.message.rawBody,
        BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
        RawBody: params.message.rawBody,
        CommandBody: params.message.commandBody ?? params.message.rawBody,
        BodyForCommands: params.message.commandBody ?? params.message.rawBody,
        From: params.from,
        To: params.reply.to,
        SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
        AccountId: params.route.accountId ?? params.accountId,
        ChatType: params.conversation.kind,
        SenderName: params.sender.name,
        SenderId: params.sender.id,
        Provider: params.provider ?? params.channel,
        Surface: params.surface ?? params.provider ?? params.channel,
        MessageSid: params.messageId,
        MessageSidFull: params.messageIdFull,
        OriginatingChannel: params.channel,
        OriginatingTo: params.reply.originatingTo,
        ...params.extra,
      }) as Awaited<ReturnType<PluginRuntime["channel"]["inbound"]["buildContext"]>>,
  );

  setZalouserRuntime({
    logging: { shouldLogVerbose: () => false },
    channel: {
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR", created: true })),
        buildPairingReply: vi.fn(() => "pair"),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        isControlCommandMessage: vi.fn(() => false),
        shouldHandleTextCommands: vi.fn(() => true),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionWithExplicit: vi.fn(() => false),
      },
      groups: {
        resolveRequireMention: vi.fn(() => false),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          sessionKey: "agent:main:zalouser:direct:u-sanitizer",
          accountId: "default",
          mainSessionKey: "agent:main:main",
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp"),
        recordInboundSession: vi.fn(async () => {}),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => undefined),
        formatAgentEnvelope: vi.fn(({ body }) => body),
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
      inbound: {
        dispatch,
        buildContext:
          buildContext as unknown as PluginRuntime["channel"]["inbound"]["buildContext"],
      },
      text: {
        resolveMarkdownTableMode: vi.fn(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
        resolveChunkMode: vi.fn(() => "length"),
        resolveTextChunkLimit: vi.fn(() => 1200),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime);

  return { dispatch, lifecycleDispatchResults, messageSendingHook };
}

async function processMessage(
  statusSink: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void,
  dispatch: ReturnType<typeof vi.fn>,
  messageSendingHook: ReturnType<typeof vi.fn>,
) {
  await withZalouserIngressTestQueue(async (ingressQueue) => {
    const abortController = new AbortController();
    type ZaloJsModule = typeof import("./zalo-js.js");
    type ListenerParams = Parameters<ZaloJsModule["startZaloListener"]>[0];
    let resolveListener: ((params: ListenerParams) => void) | undefined;
    const listenerReady = new Promise<ListenerParams>((resolve) => {
      resolveListener = resolve;
    });
    startZaloListenerMock.mockImplementationOnce(async (listenerParams) => {
      resolveListener?.(listenerParams);
      return { stop: vi.fn() };
    });
    const run = monitorZalouserProvider({
      account: createAccount(),
      config: createConfig(),
      runtime: createZalouserRuntimeEnv(),
      abortSignal: abortController.signal,
      statusSink,
      ingressQueue,
    });
    try {
      const listenerParams = await listenerReady;
      const message = createMessage();
      await listenerParams.onMessage(createRawZalouserMessageFromNormalized(message));
      if (!message.msgId) {
        throw new Error("Zalouser delivery test message requires msgId");
      }
      await vi.waitFor(() => {
        expect(dispatch).toHaveBeenCalledOnce();
        expect(messageSendingHook).toHaveBeenCalledTimes(2);
        expect(sendMessageZalouserMock).toHaveBeenCalledOnce();
      });
    } finally {
      abortController.abort();
      await run;
    }
  });
}

describe("zalouser final custom delivery sanitation", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    sendMessageZalouserMock.mockClear();
    startZaloListenerMock.mockReset();
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("sanitizes mixed and trace-only message_sending rewrites before transport", async () => {
    const statusSink = vi.fn();
    const runtime = installRuntime();

    await processMessage(statusSink, runtime.dispatch, runtime.messageSendingHook);

    expect(runtime.lifecycleDispatchResults).toMatchObject([{ dispatched: true }]);
    expect(runtime.messageSendingHook).toHaveBeenCalledTimes(2);
    expect(sendMessageZalouserMock).toHaveBeenCalledWith(
      "u-sanitizer",
      "Done.",
      expect.any(Object),
    );
    expect(sendMessageZalouserMock).toHaveBeenCalledOnce();
    expect(
      statusSink.mock.calls.filter(([patch]) => patch.lastOutboundAt !== undefined),
    ).toHaveLength(1);
  });
});
