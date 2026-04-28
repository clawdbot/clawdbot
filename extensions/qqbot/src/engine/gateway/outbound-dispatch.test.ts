import { describe, expect, it, vi, beforeEach } from "vitest";
import type { InboundContext } from "./inbound-context.js";
import { dispatchOutbound } from "./outbound-dispatch.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const sendVoiceMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: "voice-1", timestamp: "2026-04-25T00:00:00.000Z" })),
);
const sendMediaMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: "media-1", timestamp: "2026-04-25T00:00:00.000Z" })),
);
const sendTextMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: "text-1", timestamp: "2026-04-25T00:00:00.000Z" })),
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
    parsedContent: "voice",
    userContent: "voice",
    quotePart: "",
    dynamicCtx: "",
    userMessage: "voice",
    agentBody: "voice",
    body: "voice",
    systemPrompts: [],
    attachments: {
      attachmentInfo: "",
      imageUrls: [],
      imageMediaTypes: [],
      voiceAttachmentPaths: [],
      voiceAttachmentUrls: [],
      voiceAsrReferTexts: [],
      voiceTranscripts: [],
      voiceTranscriptSources: [],
      attachmentLocalPaths: [],
    },
    localMediaPaths: [],
    localMediaTypes: [],
    remoteMediaUrls: [],
    remoteMediaTypes: [],
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

function makeRuntime(params: {
  onFinalize?: (ctx: Record<string, unknown>) => void;
  onDeliver?: (
    deliver: (
      payload: { text?: string; audioAsVoice?: boolean },
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
                  payload: { text?: string; audioAsVoice?: boolean },
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
      text: {
        chunkMarkdownText: (text: string) => [text],
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

    expect(finalized).toMatchObject({
      MediaType: "audio/wav",
      MediaTypes: ["audio/wav"],
      QQVoiceAttachmentPaths: ["/tmp/qqbot/voice.wav"],
    });
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
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "voice",
        source: { base64: "silk-base64" },
        msgId: "msg-1",
        ttsText: "read this aloud",
      }),
    );
    expect(sendTextMock).not.toHaveBeenCalled();
  });
});
