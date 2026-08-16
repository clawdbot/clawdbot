import { beforeEach, describe, expect, it, vi } from "vitest";

const { transcribeFirstAudioMock } = vi.hoisted(() => ({
  transcribeFirstAudioMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>();
  return {
    ...actual,
    createChannelPreflightAudio: (
      params: Parameters<typeof actual.createChannelPreflightAudio>[0],
    ) =>
      actual.createChannelPreflightAudio({
        ...params,
        transcribeFirstAudio: transcribeFirstAudioMock,
      }),
  };
});

import {
  formatMatrixAudioTranscript,
  isMatrixAudioContent,
  resolveMatrixPreflightAudioTranscript,
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
          media: [{ path: "/tmp/inbound/voice.ogg", contentType: "audio/ogg" }],
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
});
