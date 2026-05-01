import { beforeEach, describe, expect, it, vi } from "vitest";
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

    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {},
    });

    expect(transcript).toBe("voice note transcript");
    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
  });

  it("skips audio preflight when audio config is explicitly disabled", async () => {
    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
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
      MediaPath: "/tmp/voice.ogg",
      MediaType: "audio/ogg",
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
