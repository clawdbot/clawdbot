import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runFfprobeMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const runFfmpegMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());

vi.mock("openclaw/plugin-sdk/temp-path", async () => {
  return {
    resolvePreferredOpenClawTmpDir: () => "/tmp",
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  return {
    runFfprobe: runFfprobeMock,
    runFfmpeg: runFfmpegMock,
    parseFfprobeCodecAndSampleRate: (stdout: string) => {
      const [codec, sampleRate] = stdout.trim().split(",");
      return {
        codec,
        sampleRateHz: Number(sampleRate),
      };
    },
    MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS: 1200,
    unlinkIfExists: vi.fn(async () => {}),
  };
});

let ensureOggOpus: typeof import("./voice-message.js").ensureOggOpus;

describe("ensureOggOpus", () => {
  beforeAll(async () => {
    ({ ensureOggOpus } = await import("./voice-message.js"));
  });

  beforeEach(() => {
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
  });
  it("rejects URL/protocol input paths", async () => {
    await expect(ensureOggOpus("https://example.com/audio.ogg")).rejects.toThrow(
      /local file path/i,
    );
    expect(runFfprobeMock).not.toHaveBeenCalled();
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("keeps .ogg only when codec is opus and sample rate is 48kHz", async () => {
    runFfprobeMock.mockResolvedValueOnce("opus,48000\n");

    const result = await ensureOggOpus("/tmp/input.ogg");

    expect(result).toEqual({ path: "/tmp/input.ogg", cleanup: false });
    expect(runFfprobeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["-show_entries", "stream=codec_name,sample_rate", "/tmp/input.ogg"]),
    );
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("re-encodes .ogg opus when sample rate is not 48kHz", async () => {
    runFfprobeMock.mockResolvedValueOnce("opus,24000\n");
    runFfmpegMock.mockResolvedValueOnce();

    const result = await ensureOggOpus("/tmp/input.ogg");

    expect(result.cleanup).toBe(true);
    expect(result.path).toMatch(/^\/tmp\/voice-.*\.ogg$/);
    expect(runFfmpegMock).toHaveBeenCalledWith(
      expect.arrayContaining(["-t", "1200", "-ar", "48000", "/tmp/input.ogg", result.path]),
    );
  });

  it("re-encodes non-ogg input with bounded ffmpeg execution", async () => {
    runFfmpegMock.mockResolvedValueOnce();

    const result = await ensureOggOpus("/tmp/input.mp3");

    expect(result.cleanup).toBe(true);
    expect(runFfprobeMock).not.toHaveBeenCalled();
    expect(runFfmpegMock).toHaveBeenCalledWith(
      expect.arrayContaining(["-vn", "-sn", "-dn", "/tmp/input.mp3", result.path]),
    );
  });
});
