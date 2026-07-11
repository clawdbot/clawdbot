// Discord tests cover voice message plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestClient } from "./internal/discord.js";
import { DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS } from "./monitor/timeouts.js";
import type { DiscordRetryRunner } from "./retry.js";
import type { VoiceMessageMetadata } from "./voice-message.js";

const GUARDED_FETCH_TEST_TIMEOUT_MS = 250;

const runFfprobeMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const runFfmpegMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
      timeoutMs?: number;
      policy?: { allowRfc2544BenchmarkRange?: boolean; allowIpv6UniqueLocalRange?: boolean };
      auditContext?: string;
    }) => {
      if (!Number.isFinite(params.timeoutMs) || (params.timeoutMs ?? 0) <= 0) {
        throw new Error("guarded voice upload fetch requires a finite timeout");
      }
      return {
        response: await globalThis.fetch(params.url, {
          ...params.init,
          signal: AbortSignal.timeout(GUARDED_FETCH_TEST_TIMEOUT_MS),
        }),
        release: async () => {},
      };
    },
  ),
);

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
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

let ensureOggOpus: typeof import("./voice-message.js").ensureOggOpus;
let sendDiscordVoiceMessage: typeof import("./voice-message.js").sendDiscordVoiceMessage;

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

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
      "-f",
      "ogg",
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
      "-f",
      "ogg",
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
    fetchWithSsrFGuardMock.mockClear();
  });

  function createRest(post = vi.fn(async () => ({ id: "msg-1", channel_id: "channel-1" }))) {
    return {
      options: { baseUrl: "https://discord.test/api/v10", timeout: 17 },
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
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(4);
    expect(
      fetchWithSsrFGuardMock.mock.calls.map(([params]) => ({
        auditContext: params.auditContext,
        allowRfc2544BenchmarkRange: params.policy?.allowRfc2544BenchmarkRange,
        allowIpv6UniqueLocalRange: params.policy?.allowIpv6UniqueLocalRange,
      })),
    ).toEqual([
      {
        auditContext: "discord.voice.upload-url",
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
      },
      {
        auditContext: "discord.voice.attachment-upload",
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
      },
      {
        auditContext: "discord.voice.upload-url",
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
      },
      {
        auditContext: "discord.voice.attachment-upload",
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
      },
    ]);
    expect(post).toHaveBeenCalledWith("/channels/channel-1/messages", {
      body: {
        flags: 8192,
        nonce: expect.stringMatching(/^[0-9a-f]{24}$/),
        enforce_nonce: true,
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

  it("reuses the voice-message nonce across an ambiguous create retry", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ id: "msg-1", channel_id: "channel-1" });
    const rest = createRest(post);
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
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    const request = vi.fn(async <T>(fn: () => Promise<T>, label?: string): Promise<T> => {
      if (label === "voice-message") {
        await fn().catch(() => undefined);
      }
      return await fn();
    }) as unknown as DiscordRetryRunner;

    await expect(
      sendDiscordVoiceMessage(
        rest,
        "channel-1",
        Buffer.from("ogg"),
        metadata,
        undefined,
        request,
        false,
        "bot-token",
      ),
    ).resolves.toEqual({ id: "msg-1", channel_id: "channel-1" });

    expect(post).toHaveBeenCalledTimes(2);
    const firstBody = (post.mock.calls[0]?.[1] as { body?: { nonce?: unknown } } | undefined)?.body;
    const secondBody = (post.mock.calls[1]?.[1] as { body?: { nonce?: unknown } } | undefined)
      ?.body;
    expect(firstBody?.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(secondBody?.nonce).toBe(firstBody?.nonce);
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

  it("bounds voice upload error bodies without using response.text()", async () => {
    const rest = createRest();
    const tracked = cancelTrackedResponse(`${"cdn unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
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
        return tracked.response;
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
    expect((error as Error).message).toContain("cdn unavailable");
    expect(JSON.stringify((error as { rawBody?: unknown }).rawBody)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["upload URL request", "POST /api/v10/channels/channel-1/attachments", 37],
    ["PUT upload request", "PUT /upload", DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS],
  ])("times out a hanging %s", async (_label, hangingRoute, expectedTimeoutMs) => {
    const closedResponses = vi.fn();
    let baseUrl = "";
    await withServer(
      (req, res) => {
        req.resume();
        const route = `${req.method ?? "GET"} ${req.url ?? "/"}`;
        res.on("close", () => closedResponses(route));
        if (route === hangingRoute) {
          return;
        }
        if (route !== "POST /api/v10/channels/channel-1/attachments") {
          res.statusCode = 500;
          res.end(`unexpected ${route}`);
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            attachments: [
              { id: 0, upload_url: `${baseUrl}/upload`, upload_filename: "uploaded.ogg" },
            ],
          }),
        );
      },
      async (url) => {
        baseUrl = url;
        const rest = {
          options: { baseUrl: `${baseUrl}/api/v10`, timeout: 37 },
          post: vi.fn(async () => ({ id: "msg-1", channel_id: "channel-1" })),
        } as unknown as RequestClient;

        await expect(
          sendDiscordVoiceMessage(
            rest,
            "channel-1",
            Buffer.from("ogg"),
            metadata,
            undefined,
            async (fn) => await fn(),
            false,
            "bot-token",
          ),
        ).rejects.toThrow(/timed out|abort/i);

        await vi.waitFor(() => expect(closedResponses).toHaveBeenCalledWith(hangingRoute));
        const guardedCall = fetchWithSsrFGuardMock.mock.calls.find(
          ([params]) => `${params.init?.method} ${new URL(params.url).pathname}` === hangingRoute,
        );
        expect(guardedCall?.[0].timeoutMs).toBe(expectedTimeoutMs);
      },
    );
  });
});
