import { describe, expect, it, vi } from "vitest";
import { createChannelPreflightAudio } from "./media-understanding-runtime.js";

type TranscribeFirstAudio =
  typeof import("../media-understanding/audio-preflight.js").transcribeFirstAudio;
type SendTranscriptEcho =
  typeof import("../media-understanding/echo-transcript.js").sendTranscriptEcho;

const audioConfig = {
  tools: {
    media: {
      audio: {
        echoTranscript: true,
        echoFormat: "heard: {transcript}",
      },
    },
  },
};

describe("createChannelPreflightAudio", () => {
  it("suppresses speculative echo without mutating the caller config", async () => {
    const transcribeFirstAudio = vi.fn<TranscribeFirstAudio>().mockResolvedValue("hello");
    const preflight = createChannelPreflightAudio({
      channel: "test",
      isAudio: (value: { contentType?: string }) =>
        value.contentType?.startsWith("audio/") ?? false,
      transcribeFirstAudio,
    });

    await expect(
      preflight.resolve({
        request: {
          ctx: { media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }] },
          cfg: audioConfig,
        },
      }),
    ).resolves.toBe("hello");

    expect(transcribeFirstAudio).toHaveBeenCalledWith({
      ctx: { media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }] },
      cfg: {
        tools: { media: { audio: { echoTranscript: false, echoFormat: "heard: {transcript}" } } },
      },
    });
    expect(audioConfig.tools.media.audio.echoTranscript).toBe(true);
  });

  it("preserves the original config for channels without deferred echo", async () => {
    const transcribeFirstAudio = vi.fn<TranscribeFirstAudio>().mockResolvedValue("hello");
    const preflight = createChannelPreflightAudio({
      channel: "test",
      isAudio: () => true,
      deferTranscriptEcho: false,
      transcribeFirstAudio,
    });

    await preflight.resolve({ request: { ctx: { media: [] }, cfg: audioConfig } });

    expect(transcribeFirstAudio).toHaveBeenCalledWith({ ctx: { media: [] }, cfg: audioConfig });
  });

  it("checks abort state before and after transcription", async () => {
    const before = new AbortController();
    before.abort();
    const transcribeFirstAudio = vi.fn<TranscribeFirstAudio>();
    const preflight = createChannelPreflightAudio({
      channel: "test",
      isAudio: () => true,
      transcribeFirstAudio,
    });

    await expect(
      preflight.resolve({
        request: { ctx: { media: [] }, cfg: {} },
        abortSignal: before.signal,
      }),
    ).resolves.toBeUndefined();
    expect(transcribeFirstAudio).not.toHaveBeenCalled();

    const after = new AbortController();
    transcribeFirstAudio.mockImplementation(async () => {
      after.abort();
      return "too late";
    });
    await expect(
      preflight.resolve({
        request: { ctx: { media: [] }, cfg: {} },
        abortSignal: after.signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("formats and sends admitted echoes while preserving literal replacement tokens", async () => {
    const sendTranscriptEcho = vi.fn<SendTranscriptEcho>().mockResolvedValue(undefined);
    const preflight = createChannelPreflightAudio({
      channel: "test",
      isAudio: () => true,
      sendTranscriptEcho,
    });

    expect(preflight.format("cost is $& and $1", "heard: {transcript}")).toBe(
      "heard: cost is $& and $1",
    );
    await preflight.send({
      transcript: "cost is $& and $1",
      cfg: audioConfig,
      accountId: "work",
      originatingTo: "channel:C1",
      messageThreadId: "thread-1",
    });

    expect(sendTranscriptEcho).toHaveBeenCalledWith({
      ctx: {
        Provider: "test",
        Surface: "test",
        OriginatingChannel: "test",
        OriginatingTo: "channel:C1",
        AccountId: "work",
        MessageThreadId: "thread-1",
      },
      cfg: audioConfig,
      transcript: "cost is $& and $1",
      format: "heard: {transcript}",
      logSuccess: false,
      failureLogPrefix: "test: audio transcript echo failed",
      reply: false,
    });
  });

  it("forwards native message ids, chatType, prepared replyToMode, and echoReply into the shared echo path", async () => {
    const sendTranscriptEcho = vi.fn<SendTranscriptEcho>().mockResolvedValue(undefined);
    const preflight = createChannelPreflightAudio({
      channel: "slack",
      isAudio: () => true,
      sendTranscriptEcho,
    });
    const cfg = {
      tools: {
        media: {
          audio: {
            echoTranscript: true,
            echoReply: true,
            echoFormat: "heard: {transcript}",
          },
        },
      },
    };

    await preflight.send({
      transcript: "threaded",
      cfg,
      accountId: "work",
      originatingTo: "channel:C1",
      messageThreadId: "1.000",
      messageId: "1710000.000100",
      chatType: "direct",
      replyToMode: "off",
    });

    expect(sendTranscriptEcho).toHaveBeenCalledWith({
      ctx: {
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C1",
        AccountId: "work",
        MessageThreadId: "1.000",
        ChatType: "direct",
        ReplyToMode: "off",
        MessageSid: "1710000.000100",
        MessageSidFirst: "1710000.000100",
        MessageSidFull: "slack:1710000.000100",
      },
      cfg,
      transcript: "threaded",
      format: "heard: {transcript}",
      logSuccess: false,
      failureLogPrefix: "slack: audio transcript echo failed",
      reply: true,
    });
  });

  it("does not send when echo is disabled", async () => {
    const sendTranscriptEcho = vi.fn<SendTranscriptEcho>();
    const preflight = createChannelPreflightAudio({
      channel: "test",
      isAudio: () => true,
      sendTranscriptEcho,
    });

    await preflight.send({
      transcript: "hello",
      cfg: {},
      accountId: "work",
      originatingTo: "channel:C1",
    });

    expect(sendTranscriptEcho).not.toHaveBeenCalled();
  });
});
