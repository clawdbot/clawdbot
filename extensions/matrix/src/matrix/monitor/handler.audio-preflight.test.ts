import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
} from "./handler.test-helpers.js";

const { downloadMatrixMediaMock, sendDurableMessageBatchMock, transcribeFirstAudioMock } =
  vi.hoisted(() => ({
    downloadMatrixMediaMock: vi.fn(),
    sendDurableMessageBatchMock: vi.fn(),
    transcribeFirstAudioMock: vi.fn(),
  }));

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
  };
});

vi.mock("./preflight-audio.runtime.js", () => ({
  sendDurableMessageBatch: sendDurableMessageBatchMock,
  transcribeFirstAudio: transcribeFirstAudioMock,
}));

function createAudioPreflightHarness(
  overrides: Parameters<typeof createMatrixHandlerTestHarness>[0] = {},
) {
  return createMatrixHandlerTestHarness({
    isDirectMessage: true,
    shouldHandleTextCommands: () => true,
    resolveMarkdownTableMode: () => "code",
    resolveAgentRoute: () => ({
      agentId: "main",
      accountId: "ops",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
      mainSessionKey: "agent:main:main",
      channel: "matrix",
      matchedBy: "binding.account",
    }),
    resolveStorePath: () => "/tmp/openclaw-test-session.json",
    readSessionUpdatedAt: () => 123,
    getRoomInfo: async () => ({
      name: "Audio Room",
      canonicalAlias: "#audio:example.org",
      altAliases: [],
    }),
    getMemberDisplayName: async () => "Frank",
    startupMs: Date.now() - 120_000,
    startupGraceMs: 60_000,
    textLimit: 4000,
    mediaMaxBytes: 5 * 1024 * 1024,
    replyToMode: "first",
    ...overrides,
  });
}

function createAudioEvent(content: Record<string, unknown>) {
  return createMatrixRoomMessageEvent({
    eventId: "$audio1",
    sender: "@frank:matrix.example.org",
    content: content as never,
  });
}

function expectLatestInboundContext(
  recordInboundSession: ReturnType<typeof createMatrixHandlerTestHarness>["recordInboundSession"],
) {
  const call = vi.mocked(recordInboundSession).mock.calls.at(-1)?.[0] as
    | { ctx?: Record<string, unknown> }
    | undefined;
  if (!call?.ctx) {
    throw new Error("expected inbound session context");
  }
  return call.ctx;
}

describe("createMatrixRoomMessageHandler audio preflight", () => {
  beforeEach(() => {
    downloadMatrixMediaMock.mockReset();
    sendDurableMessageBatchMock.mockReset();
    transcribeFirstAudioMock.mockReset();
    installMatrixMonitorTestRuntime();
  });

  it("transcribes inbound voice notes in DMs and surfaces the transcript as the agent body", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("hello bot");
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaPaths: ["/tmp/inbound/voice.ogg"],
          MediaTypes: ["audio/ogg"],
          Provider: "matrix",
          Surface: "matrix",
          OriginatingChannel: "matrix",
          OriginatingTo: "room:!room:example.org",
          AccountId: "ops",
          ChatType: "direct",
          SessionKey: "agent:main:matrix:channel:!room:example.org",
        }),
      }),
    );
    expect(expectLatestInboundContext(recordInboundSession)).toMatchObject({
      BodyForAgent: '[Audio transcript (machine-generated, untrusted)]: "hello bot"',
      MediaTranscribedIndexes: [0],
      MediaPath: "/tmp/inbound/voice.ogg",
      MediaType: "audio/ogg",
    });
  });

  it("lets transcript-mentioned voice notes pass the requireMention room gate", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("bot can you check this");
    const { handler, recordInboundSession } = createAudioPreflightHarness({
      isDirectMessage: false,
      mentionRegexes: [/\bbot\b/i],
      roomsConfig: {
        "!room:example.org": { requireMention: true } as never,
      },
    });

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(expectLatestInboundContext(recordInboundSession)).toMatchObject({
      BodyForAgent: expect.stringContaining("bot can you check this"),
      WasMentioned: true,
    });
  });

  it("keeps non-filename audio fallback text while still surfacing the transcript", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("hello bot from fallback audio");
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "Voice message",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(expectLatestInboundContext(recordInboundSession)).toMatchObject({
      BodyForAgent:
        'Voice message\n[Audio transcript (machine-generated, untrusted)]: "hello bot from fallback audio"',
      MediaTranscribedIndexes: [0],
    });
  });

  it("echoes accepted preflight transcripts after the mention gate", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    sendDurableMessageBatchMock.mockResolvedValue({ status: "sent", results: [] });
    transcribeFirstAudioMock.mockResolvedValue("hello bot");
    const { handler } = createAudioPreflightHarness({
      cfg: {
        channels: { matrix: { dm: { allowFrom: ["*"] } } },
        tools: { media: { audio: { enabled: true, echoTranscript: true } } },
      },
    });

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(sendDurableMessageBatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        to: "room:!room:example.org",
        accountId: "ops",
        payloads: [{ text: '📝 "hello bot"' }],
        bestEffort: true,
        durability: "best_effort",
      }),
    );
  });

  it("drops transcript-unmentioned voice notes in requireMention rooms", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("hello world");
    const { handler, recordInboundSession } = createAudioPreflightHarness({
      isDirectMessage: false,
      historyLimit: 5,
      mentionRegexes: [/\bbot\b/i],
      roomsConfig: {
        "!room:example.org": { requireMention: true } as never,
      },
    });

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(recordInboundSession).not.toHaveBeenCalled();

    await handler(
      "!room:example.org",
      createMatrixRoomMessageEvent({
        eventId: "$text-after-unmentioned-audio",
        sender: "@frank:matrix.example.org",
        content: { msgtype: "m.text", body: "bot what did I say before?" },
      }),
    );

    const followUpContext = expectLatestInboundContext(recordInboundSession);
    const history = followUpContext.InboundHistory as Array<{ body?: string }> | undefined;
    expect(history?.map((entryValue) => entryValue.body)).toContain(
      '[Audio transcript (machine-generated, untrusted)]: "hello world"',
    );
  });

  it("does not preflight-download gated audio when audio transcription is disabled", async () => {
    const { handler, recordInboundSession } = createAudioPreflightHarness({
      cfg: {
        channels: { matrix: { dm: { allowFrom: ["*"] } } },
        tools: { media: { audio: { enabled: false } } },
      },
      isDirectMessage: false,
      mentionRegexes: [/\bbot\b/i],
      roomsConfig: {
        "!room:example.org": { requireMention: true } as never,
      },
    });

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(downloadMatrixMediaMock).not.toHaveBeenCalled();
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("does not hold the room history ingress queue during slow audio preflight", async () => {
    let releaseDownload:
      | ((media: { path: string; contentType: string; placeholder: string }) => void)
      | undefined;
    downloadMatrixMediaMock.mockReturnValue(
      new Promise((resolve) => {
        releaseDownload = resolve;
      }),
    );
    transcribeFirstAudioMock.mockResolvedValue("bot voice request");
    const { handler, recordInboundSession } = createAudioPreflightHarness({
      isDirectMessage: false,
      historyLimit: 5,
      mentionRegexes: [/\bbot\b/i],
      roomsConfig: {
        "!room:example.org": { requireMention: true } as never,
      },
    });

    const slowAudio = handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    await handler(
      "!room:example.org",
      createMatrixRoomMessageEvent({
        eventId: "$text-after-audio",
        sender: "@frank:matrix.example.org",
        content: { msgtype: "m.text", body: "bot text after audio" },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ BodyForAgent: "bot text after audio" }),
      }),
    );

    releaseDownload?.({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    await slowAudio;

    const voiceCall = vi
      .mocked(recordInboundSession)
      .mock.calls.map((call) => call[0] as { ctx?: Record<string, unknown> })
      .find((call) => {
        const bodyForAgent = call.ctx?.BodyForAgent;
        return typeof bodyForAgent === "string" && bodyForAgent.includes("bot voice request");
      });
    const voiceHistory = voiceCall?.ctx?.InboundHistory as Array<{ body?: string }> | undefined;
    expect(voiceHistory?.map((entry) => entry.body) ?? []).not.toContain("bot text after audio");
  });

  it("keeps placeholder body when transcription fails", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockRejectedValue(new Error("STT down"));
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(expectLatestInboundContext(recordInboundSession)).toMatchObject({
      BodyForAgent: "[matrix audio attachment]",
      MediaPath: "/tmp/inbound/voice.ogg",
    });
    expect(
      expectLatestInboundContext(recordInboundSession).MediaTranscribedIndexes,
    ).toBeUndefined();
  });

  it("does not invoke audio preflight for non-audio media", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/photo.jpg",
      contentType: "image/jpeg",
      placeholder: "[matrix image attachment]",
    });
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.image",
        body: "photo.jpg",
        url: "mxc://example/photo",
        info: { mimetype: "image/jpeg", size: 12345 },
      }),
    );

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("transcribes encrypted voice notes after existing Matrix media decryption", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/encrypted-voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("encrypted hello");
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        file: {
          url: "mxc://example/encrypted-voice",
          key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
          iv: "iv",
          hashes: { sha256: "hash" },
          v: "v2",
        },
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(downloadMatrixMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mxcUrl: "mxc://example/encrypted-voice",
        file: expect.objectContaining({
          url: "mxc://example/encrypted-voice",
          key: expect.objectContaining({ alg: "A256CTR" }),
        }),
      }),
    );
    expect(expectLatestInboundContext(recordInboundSession)).toMatchObject({
      BodyForAgent: '[Audio transcript (machine-generated, untrusted)]: "encrypted hello"',
      MediaTranscribedIndexes: [0],
      MediaPath: "/tmp/inbound/encrypted-voice.ogg",
    });
  });

  it("preserves the too-large placeholder when audio download exceeds the size limit", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new MatrixMediaSizeLimitError());
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "big-voice.ogg",
        url: "mxc://example/big-voice",
        info: { mimetype: "audio/ogg", size: 10 * 1024 * 1024 },
      }),
    );

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(expectLatestInboundContext(recordInboundSession)).toMatchObject({
      BodyForAgent: "[matrix audio attachment too large]",
    });
    expect(expectLatestInboundContext(recordInboundSession).MediaPath).toBeUndefined();
  });

  it("downloads audio only once across preflight and normal media handling", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("hello bot");
    const { handler } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(downloadMatrixMediaMock).toHaveBeenCalledTimes(1);
  });
});
