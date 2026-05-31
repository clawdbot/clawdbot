import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { InboundContext } from "./inbound-context.js";
import { dispatchOutbound } from "./outbound-dispatch.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const sendVoiceMessageMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ id: "voice-1", timestamp: "2026-04-25T00:00:00.000Z" })),
);
const sendMediaMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ id: "media-1", timestamp: "2026-04-25T00:00:00.000Z" })),
);
const sendTextMock = vi.hoisted(() =>
  vi.fn(async (..._params: unknown[]) => ({
    id: "text-1",
    timestamp: "2026-04-25T00:00:00.000Z",
  })),
);
const audioFileToSilkBase64Mock = vi.hoisted(() => vi.fn(async () => "silk-base64"));

vi.mock("../messaging/sender.js", () => ({
  accountToCreds: (account: GatewayAccount) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  buildDeliveryTarget: (target: { type: string; senderId: string; groupOpenid?: string }) => ({
    type: target.type === "group" ? "group" : target.type === "c2c" ? "c2c" : target.type,
    id: target.type === "group" ? target.groupOpenid : target.senderId,
  }),
  initApiConfig: vi.fn(),
  sendFileMessage: vi.fn(),
  sendImage: vi.fn(),
  sendText: sendTextMock,
  sendVideoMessage: vi.fn(),
  sendVoiceMessage: sendVoiceMessageMock,
  sendMedia: sendMediaMock,
  withTokenRetry: async (_creds: unknown, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock("../utils/audio.js", () => ({
  audioFileToSilkBase64: audioFileToSilkBase64Mock,
}));

const account: GatewayAccount = {
  accountId: "qq-main",
  appId: "app",
  clientSecret: "secret",
  markdownSupport: false,
  config: {},
};

function makeInbound(overrides: Partial<InboundContext> = {}): InboundContext {
  return {
    event: {
      type: "c2c",
      senderId: "user-openid",
      messageId: "msg-1",
      content: "voice",
      timestamp: "2026-04-25T00:00:00.000Z",
    },
    route: { sessionKey: "qqbot:c2c:user-openid", accountId: "qq-main" },
    isGroupChat: false,
    peerId: "user-openid",
    qualifiedTarget: "qqbot:c2c:user-openid",
    fromAddress: "qqbot:c2c:user-openid",
    agentBody: "voice",
    body: "voice",
    localMediaPaths: [],
    localMediaTypes: [],
    remoteMediaUrls: [],
    uniqueVoicePaths: [],
    uniqueVoiceUrls: [],
    uniqueVoiceAsrReferTexts: [],
    voiceMediaTypes: [],
    hasAsrReferFallback: false,
    voiceTranscriptSources: [],
    commandAuthorized: false,
    blocked: false,
    skipped: false,
    typing: { keepAlive: null },
    ...overrides,
  };
}

function makeInboundRuntime(): GatewayPluginRuntime["channel"]["inbound"] {
  return {
    run: vi.fn(async (rawParams: unknown) => {
      const params = rawParams as {
        raw: unknown;
        adapter: {
          ingest: (raw: unknown) => unknown;
          resolveTurn: (...args: unknown[]) => unknown;
        };
      };
      const input = await params.adapter.ingest(params.raw);
      const turn = (await params.adapter.resolveTurn(
        input,
        {
          canStartAgentTurn: true,
          kind: "message",
        },
        {},
      )) as { runDispatch: () => Promise<unknown> };
      return { dispatchResult: await turn.runDispatch() };
    }),
  };
}

function makeRuntime(params: {
  onFinalize?: (ctx: Record<string, unknown>) => void;
  isControlCommandMessage?: (text?: string, cfg?: unknown) => boolean;
  onDeliver?: (
    deliver: (
      payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; audioAsVoice?: boolean },
      info: { kind: string },
    ) => Promise<void>,
  ) => Promise<void>;
}): GatewayPluginRuntime {
  return {
    channel: {
      activity: { record: vi.fn() },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "qqbot:c2c:user-openid",
          accountId: "qq-main",
        })),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (rawParams: unknown) => {
          const deliver = (
            rawParams as {
              dispatcherOptions: {
                deliver: (
                  payload: {
                    text?: string;
                    mediaUrl?: string;
                    mediaUrls?: string[];
                    audioAsVoice?: boolean;
                  },
                  info: { kind: string },
                ) => Promise<void>;
              };
            }
          ).dispatcherOptions.deliver;
          await params.onDeliver?.(deliver);
        }),
        finalizeInboundContext: vi.fn((rawCtx: Record<string, unknown>) => {
          params.onFinalize?.(rawCtx);
          return rawCtx;
        }),
        formatInboundEnvelope: vi.fn(() => "voice"),
        resolveEffectiveMessagesConfig: vi.fn(() => ({})),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/openclaw/qqbot-sessions.json"),
        recordInboundSession: vi.fn(async () => undefined),
      },
      inbound: makeInboundRuntime(),
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
      commands: {
        isControlCommandMessage: params.isControlCommandMessage ?? (() => false),
      },
    },
    tts: {
      textToSpeech: vi.fn(async () => ({
        success: true,
        audioPath: "/tmp/openclaw-qqbot/tts.wav",
        provider: "test-tts",
        outputFormat: "wav",
      })),
    },
  };
}

describe("dispatchOutbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps waiting past 300s when a slow provider timeout is configured", async () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime({
        onDeliver: async (deliver) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 301_000));
          await deliver({ text: "late answer" }, { kind: "block" });
        },
      });
      let settled = false;

      const dispatchPromise = dispatchOutbound(makeInbound(), {
        runtime,
        cfg: {
          models: { providers: { ollama: { timeoutSeconds: 1800 } } },
        },
        account,
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(300_000);

      expect(settled).toBe(false);
      expect(sendTextMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await dispatchPromise;

      expect(sendTextMock).toHaveBeenCalledWith(
        expect.anything(),
        "late answer",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("marks voice-only inbound as audio without adding voice paths to MediaPaths", async () => {
    let finalized: Record<string, unknown> | undefined;
    const runtime = makeRuntime({ onFinalize: (ctx) => (finalized = ctx) });

    await dispatchOutbound(
      makeInbound({
        uniqueVoicePaths: ["/tmp/qqbot/voice.wav"],
        voiceMediaTypes: ["audio/wav"],
      }),
      { runtime, cfg: {}, account },
    );

    expect(finalized?.MediaType).toBe("audio/wav");
    expect(finalized?.MediaTypes).toEqual(["audio/wav"]);
    expect(finalized?.QQVoiceAttachmentPaths).toEqual(["/tmp/qqbot/voice.wav"]);
    expect(finalized).not.toHaveProperty("MediaPath");
    expect(finalized).not.toHaveProperty("MediaPaths");
  });

  it("synthesizes plain audioAsVoice text as a QQ voice reply", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "read this aloud", audioAsVoice: true }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), { runtime, cfg: {}, account });

    expect(runtime.tts.textToSpeech).toHaveBeenCalledWith({
      text: "read this aloud",
      cfg: {},
      channel: "qqbot",
      accountId: "qq-main",
    });
    expect(audioFileToSilkBase64Mock).toHaveBeenCalledWith("/tmp/openclaw-qqbot/tts.wav");
    const sentMedia = sendMediaMock.mock.calls.at(0)?.[0] as
      | { kind?: string; source?: unknown; msgId?: string; ttsText?: string }
      | undefined;
    expect(sentMedia?.kind).toBe("voice");
    expect(sentMedia?.source).toEqual({ base64: "silk-base64" });
    expect(sentMedia?.msgId).toBe("msg-1");
    expect(sentMedia?.ttsText).toBe("read this aloud");
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it("delivers text-only tool progress immediately in partial streaming mode", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: { mode: "partial" } } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("delivers text-only tool progress immediately in recommended C2C streaming mode", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: true } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("delivers text-only tool progress for legacy C2C stream API accounts", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: {
        ...account,
        config: { streaming: { mode: "off", c2cStreamApi: true } },
      },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("keeps immediate tool progress media-like text inert with markdown support enabled", async () => {
    const progress = "progress ![x](http://internal.example/progress.png)";
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: progress }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, markdownSupport: true, config: { streaming: { mode: "partial" } } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([progress, "final answer"]);
    expect(sendTextMock.mock.calls[0]?.[3]).toMatchObject({ forcePlainText: true });
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("keeps text-only tool progress buffered when streaming is off", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: false } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["final answer"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("renews pending tool-media fallback when partial progress is delivered", async () => {
    vi.useFakeTimers();
    const mediaUrl = "https://example.com/progress.png";
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ mediaUrl }, { kind: "tool" });
        await vi.advanceTimersByTimeAsync(59_000);
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sendMediaMock).not.toHaveBeenCalled();
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: { mode: "partial" } } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).toHaveBeenCalledTimes(1);
  });

  it("marks recognized C2C framework slash commands as text commands", async () => {
    let finalized: Record<string, unknown> | undefined;
    const runtime = makeRuntime({
      isControlCommandMessage: (text) => text === "/models",
      onFinalize: (ctx) => (finalized = ctx),
    });

    await dispatchOutbound(
      makeInbound({
        event: {
          type: "c2c",
          senderId: "user-openid",
          messageId: "msg-models",
          content: "/models",
          timestamp: "2026-04-25T00:00:00.000Z",
        },
        agentBody: "/models",
        body: "/models",
        commandAuthorized: true,
      }),
      { runtime, cfg: { commands: { text: true } }, account },
    );

    expect(finalized?.CommandBody).toBe("/models");
    expect(finalized?.CommandAuthorized).toBe(true);
    expect(finalized?.CommandSource).toBe("text");
    expect(finalized?.Provider).toBe("qqbot");
    expect(finalized?.Surface).toBe("qqbot");
    expect(finalized?.ChatType).toBe("direct");
  });
});
