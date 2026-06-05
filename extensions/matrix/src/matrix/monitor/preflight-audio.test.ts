import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendDurableMessageBatchMock, transcribeFirstAudioMock } = vi.hoisted(() => ({
  sendDurableMessageBatchMock: vi.fn(),
  transcribeFirstAudioMock: vi.fn(),
}));

vi.mock("./preflight-audio.runtime.js", () => ({
  sendDurableMessageBatch: sendDurableMessageBatchMock,
  transcribeFirstAudio: transcribeFirstAudioMock,
}));

import {
  formatMatrixAudioTranscript,
  isMatrixAudioContent,
  resolveMatrixPreflightAudioTranscript,
  sendMatrixPreflightAudioTranscriptEcho,
} from "./preflight-audio.js";

const cfg = {} as import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;

describe("isMatrixAudioContent", () => {
  it("accepts Matrix audio messages and audio files", () => {
    expect(isMatrixAudioContent({ msgtype: "m.audio" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "audio/ogg" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "AUDIO/MP4" })).toBe(true);
  });

  it("rejects non-audio Matrix content", () => {
    expect(isMatrixAudioContent({ msgtype: "m.image", mimetype: "image/png" })).toBe(false);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "application/pdf" })).toBe(false);
    expect(isMatrixAudioContent({ mimetype: "audio/ogg" })).toBe(false);
  });
});

describe("formatMatrixAudioTranscript", () => {
  it("wraps transcripts with untrusted machine-generated framing", () => {
    expect(formatMatrixAudioTranscript('say "hi"\nthen go')).toBe(
      `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify('say "hi"\nthen go')}`,
    );
  });
});

describe("resolveMatrixPreflightAudioTranscript", () => {
  beforeEach(() => {
    sendDurableMessageBatchMock.mockReset();
    transcribeFirstAudioMock.mockReset();
  });

  it("passes the Matrix-local media path to shared audio preflight", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello from voice");

    const transcript = await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      mediaContentType: "audio/ogg",
      cfg,
      accountId: "ops",
      chatType: "channel",
      originatingTo: "room:!room:example.org",
      messageThreadId: "$thread",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
    });

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
          MessageThreadId: "$thread",
          ChatType: "channel",
          SessionKey: "agent:main:matrix:channel:!room:example.org",
        }),
        cfg,
      }),
    );
    expect(transcript).toBe("hello from voice");
  });

  it("suppresses shared echo during pre-mention transcription", async () => {
    const echoCfg = {
      tools: { media: { audio: { echoTranscript: true, echoFormat: "echo: {transcript}" } } },
    } as import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;
    transcribeFirstAudioMock.mockResolvedValue("hello from voice");

    await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      mediaContentType: "audio/ogg",
      cfg: echoCfg,
      accountId: "ops",
      chatType: "channel",
      originatingTo: "room:!room:example.org",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
    });

    const callCfg = transcribeFirstAudioMock.mock.calls[0]?.[0]?.cfg as
      | { tools?: { media?: { audio?: { echoTranscript?: unknown } } } }
      | undefined;
    expect(callCfg?.tools?.media?.audio?.echoTranscript).toBe(false);
  });

  it("swallows provider failures and aborts", async () => {
    transcribeFirstAudioMock.mockRejectedValue(new Error("STT down"));
    await expect(
      resolveMatrixPreflightAudioTranscript({
        mediaPath: "/tmp/inbound/voice.ogg",
        cfg,
        accountId: "ops",
        chatType: "direct",
        originatingTo: "room:!dm:example.org",
        sessionKey: "agent:main:matrix:direct:@frank:example.org",
      }),
    ).resolves.toBeUndefined();

    const controller = new AbortController();
    controller.abort();
    transcribeFirstAudioMock.mockClear();
    await expect(
      resolveMatrixPreflightAudioTranscript({
        mediaPath: "/tmp/inbound/voice.ogg",
        cfg,
        accountId: "ops",
        chatType: "direct",
        originatingTo: "room:!dm:example.org",
        sessionKey: "agent:main:matrix:direct:@frank:example.org",
        abortSignal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
  });
});

describe("sendMatrixPreflightAudioTranscriptEcho", () => {
  beforeEach(() => {
    sendDurableMessageBatchMock.mockReset();
    transcribeFirstAudioMock.mockReset();
  });

  it("sends accepted Matrix preflight transcript echoes through durable delivery", async () => {
    sendDurableMessageBatchMock.mockResolvedValue({ status: "sent", results: [] });
    await sendMatrixPreflightAudioTranscriptEcho({
      transcript: "hello bot",
      cfg: {
        tools: { media: { audio: { echoTranscript: true, echoFormat: "heard: {transcript}" } } },
      } as import("openclaw/plugin-sdk/config-contracts").OpenClawConfig,
      accountId: "ops",
      originatingTo: "room:!room:example.org",
      messageThreadId: "$thread",
    });

    expect(sendDurableMessageBatchMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      channel: "matrix",
      to: "room:!room:example.org",
      accountId: "ops",
      threadId: "$thread",
      payloads: [{ text: "heard: hello bot" }],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("does not echo when transcript echo is disabled", async () => {
    await sendMatrixPreflightAudioTranscriptEcho({
      transcript: "hello bot",
      cfg,
      accountId: "ops",
      originatingTo: "room:!room:example.org",
    });

    expect(sendDurableMessageBatchMock).not.toHaveBeenCalled();
  });
});
