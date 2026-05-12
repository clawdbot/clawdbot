import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestClient } from "./internal/discord.js";
import type { VoiceMessageMetadata } from "./voice-message.js";

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

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  return {
    fetchWithSsrFGuard: async (params: { url: string; init?: RequestInit }) => ({
      response: await globalThis.fetch(params.url, params.init),
      release: async () => {},
    }),
  };
});

let ensureOggOpus: typeof import("./voice-message.js").ensureOggOpus;
let sendDiscordVoiceMessage: typeof import("./voice-message.js").sendDiscordVoiceMessage;

describe("ensureOggOpus", () => {
  beforeAll(async () => {
    ({ ensureOggOpus, sendDiscordVoiceMessage } = await import("./voice-message.js"));
  });

  beforeEach(() => {
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
  });

  function expectStagedFfmpegOutput(ffmpegOutputPath: string | undefined, finalPath: string) {
    expect(ffmpegOutputPath).toBeTypeOf("string");
    if (typeof ffmpegOutputPath !== "string") {
      throw new Error("missing ffmpeg output path");
    }
    expect(ffmpegOutputPath).not.toBe(finalPath);
    const stagedBase = path.basename(ffmpegOutputPath);
    expect(stagedBase.startsWith(".fs-safe-output-")).toBe(true);
    expect(stagedBase.endsWith(`-${path.basename(finalPath)}.part`)).toBe(true);
  }

  function readSingleCommandArgs(mock: typeof runFfprobeMock | typeof runFfmpegMock): string[] {
    const [call] = mock.mock.calls;
    if (!call) {
      throw new Error("missing command call");
    }
    const [args] = call;
    if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
      throw new Error("missing command args");
    }
    return args;
  }

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
    expect(runFfprobeMock).toHaveBeenCalledTimes(1);
    expect(readSingleCommandArgs(runFfprobeMock)).toEqual([
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,sample_rate",
      "-of",
      "csv=p=0",
      "/tmp/input.ogg",
    ]);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("re-encodes .ogg opus when sample rate is not 48kHz", async () => {
    runFfprobeMock.mockResolvedValueOnce("opus,24000\n");
    runFfmpegMock.mockImplementationOnce(async (...callArgs: unknown[]) => {
      const args = callArgs[0] as string[];
      const outputPath = args.at(-1);
      if (typeof outputPath !== "string") {
        throw new Error("missing ffmpeg output path");
      }
      await fs.writeFile(outputPath, "ogg");
    });

    const result = await ensureOggOpus("/tmp/input.ogg");

    expect(result.cleanup).toBe(true);
    expect(path.dirname(result.path)).toBe(path.normalize("/tmp"));
    expect(path.basename(result.path)).toMatch(/^voice-.*\.ogg$/);
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    const ffmpegArgs = readSingleCommandArgs(runFfmpegMock);
    expect(ffmpegArgs.slice(0, -1)).toEqual([
      "-y",
      "-i",
      "/tmp/input.ogg",
      "-vn",
      "-sn",
      "-dn",
      "-t",
      "1200",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
    ]);
    const ffmpegOutputPath = ffmpegArgs.at(-1);
    expectStagedFfmpegOutput(ffmpegOutputPath, result.path);
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("ogg");
  });

  it("re-encodes non-ogg input with bounded ffmpeg execution", async () => {
    runFfmpegMock.mockImplementationOnce(async (...callArgs: unknown[]) => {
      const args = callArgs[0] as string[];
      const outputPath = args.at(-1);
      if (typeof outputPath !== "string") {
        throw new Error("missing ffmpeg output path");
      }
      await fs.writeFile(outputPath, "ogg");
    });

    const result = await ensureOggOpus("/tmp/input.mp3");

    expect(result.cleanup).toBe(true);
    expect(runFfprobeMock).not.toHaveBeenCalled();
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    const ffmpegArgs = readSingleCommandArgs(runFfmpegMock);
    expect(ffmpegArgs.slice(0, -1)).toEqual([
      "-y",
      "-i",
      "/tmp/input.mp3",
      "-vn",
      "-sn",
      "-dn",
      "-t",
      "1200",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
    ]);
    const ffmpegOutputPath = ffmpegArgs.at(-1);
    expectStagedFfmpegOutput(ffmpegOutputPath, result.path);
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("ogg");
  });
});

describe("sendDiscordVoiceMessage", () => {
  const metadata: VoiceMessageMetadata = {
    durationSecs: 1,
    waveform: "waveform",
  };

  beforeAll(async () => {
    ({ sendDiscordVoiceMessage } = await import("./voice-message.js"));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createRest(post = vi.fn(async () => ({ id: "msg-1", channel_id: "channel-1" }))) {
    return {
      options: { baseUrl: "https://discord.test/api/v10" },
      post,
    } as unknown as RequestClient;
  }

  async function retryRateLimits<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!(err instanceof Error) || err.name !== "RateLimitError") {
          throw err;
        }
      }
    }
    throw lastError;
  }

  it("requests a fresh upload URL when the CDN upload is rate limited", async () => {
    const post = vi.fn(async () => ({ id: "msg-1", channel_id: "channel-1" }));
    const rest = createRest(post);
    let uploadUrlRequests = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (method === "POST" && url.endsWith("/channels/channel-1/attachments")) {
        uploadUrlRequests += 1;
        return new Response(
          JSON.stringify({
            attachments: [
              {
                id: 0,
                upload_url: `https://cdn.test/upload-${uploadUrlRequests}`,
                upload_filename: `uploaded-${uploadUrlRequests}.ogg`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (method === "PUT" && url === "https://cdn.test/upload-1") {
        return new Response(
          JSON.stringify({ message: "Slow down", retry_after: 0, global: false }),
          { status: 429 },
        );
      }
      if (method === "PUT" && url === "https://cdn.test/upload-2") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    await expect(
      sendDiscordVoiceMessage(
        rest,
        "channel-1",
        Buffer.from("ogg"),
        metadata,
        undefined,
        retryRateLimits,
        false,
        "bot-token",
      ),
    ).resolves.toEqual({ id: "msg-1", channel_id: "channel-1" });

    expect(uploadUrlRequests).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(post).toHaveBeenCalledWith("/channels/channel-1/messages", {
      body: {
        flags: 8192,
        attachments: [
          {
            id: "0",
            filename: "voice-message.ogg",
            uploaded_filename: "uploaded-2.ogg",
            duration_secs: 1,
            waveform: "waveform",
          },
        ],
      },
    });
  });

  it("throws typed CDN upload failures", async () => {
    const rest = createRest();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (method === "POST" && url.endsWith("/channels/channel-1/attachments")) {
        return new Response(
          JSON.stringify({
            attachments: [
              {
                id: 0,
                upload_url: "https://cdn.test/upload",
                upload_filename: "uploaded.ogg",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (method === "PUT" && url === "https://cdn.test/upload") {
        return new Response("cdn unavailable", { status: 503 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    let error: unknown;
    try {
      await sendDiscordVoiceMessage(
        rest,
        "channel-1",
        Buffer.from("ogg"),
        metadata,
        undefined,
        async (fn) => await fn(),
        false,
        "bot-token",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("DiscordError");
    expect((error as { status?: unknown }).status).toBe(503);
    expect((error as { statusCode?: unknown }).statusCode).toBe(503);
    expect((error as { rawBody?: unknown }).rawBody).toEqual({
      message: "cdn unavailable",
    });
  });
});
