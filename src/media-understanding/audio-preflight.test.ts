// Audio preflight tests cover auto mode, explicit disable, and transcript echo
// delivery settings.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { transcribeFirstAudio } from "./audio-preflight.js";

const runAudioTranscriptionMock = vi.hoisted(() => vi.fn());
const sendTranscriptEchoMock = vi.hoisted(() => vi.fn());

vi.mock("./audio-transcription-runner.js", () => ({
  runAudioTranscription: (...args: unknown[]) => runAudioTranscriptionMock(...args),
}));

vi.mock("./echo-transcript.js", () => ({
  DEFAULT_ECHO_TRANSCRIPT_FORMAT: '📝 "{transcript}"',
  sendTranscriptEcho: (...args: unknown[]) => sendTranscriptEchoMock(...args),
}));

describe("transcribeFirstAudio", () => {
  beforeEach(() => {
    runAudioTranscriptionMock.mockReset();
    sendTranscriptEchoMock.mockReset();
  });

  it("runs audio preflight in auto mode when audio config is absent", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "voice note transcript",
      attachments: [],
    });

    const ctx: MsgContext = {
      Body: "<media:audio>",
      media: [
        { path: "/tmp/photo.jpg", contentType: "image/jpeg" },
        { path: "/tmp/voice.ogg", contentType: "audio/ogg" },
      ],
    };
    const transcript = await transcribeFirstAudio({ ctx, cfg: {} });

    expect(transcript).toBe("voice note transcript");
    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
    expect(ctx.media?.[0]?.transcribed).not.toBe(true);
    expect(ctx.media?.[1]?.transcribed).toBe(true);
  });

  it("skips audio preflight when audio config is explicitly disabled", async () => {
    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
      },
      cfg: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
    });

    expect(transcript).toBeUndefined();
    expect(runAudioTranscriptionMock).not.toHaveBeenCalled();
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
  });

  it("echoes the preflight transcript when echoTranscript is enabled", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "hello from dm audio",
      attachments: [],
    });

    const ctx = {
      Body: "<media:audio>",
      Provider: "telegram",
      OriginatingTo: "telegram:42",
      AccountId: "default",
      media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
    };
    const cfg = {
      tools: {
        media: {
          audio: {
            enabled: true,
            echoTranscript: true,
            echoFormat: "Heard: {transcript}",
          },
        },
      },
    };

    const transcript = await transcribeFirstAudio({ ctx, cfg });

    expect(transcript).toBe("hello from dm audio");
    expect(sendTranscriptEchoMock).toHaveBeenCalledOnce();
    expect(sendTranscriptEchoMock).toHaveBeenCalledWith({
      ctx,
      cfg,
      transcript: "hello from dm audio",
      format: "Heard: {transcript}",
    });
  });
});
