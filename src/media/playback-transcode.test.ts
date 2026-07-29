import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

const { runFfmpeg } = vi.hoisted(() => ({
  runFfmpeg: vi.fn(),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfmpeg,
}));

let playback: typeof import("./playback-transcode.js");
let tempHome: TempHomeEnv;

beforeAll(async () => {
  tempHome = await createTempHomeEnv("openclaw-playback-transcode-");
  playback = await import("./playback-transcode.js");
});

afterAll(async () => {
  await tempHome.restore();
});

beforeEach(() => {
  runFfmpeg.mockReset();
});

async function createSource(fileName: string, contents = "source") {
  const fixturePath = path.join(tempHome.home, fileName);
  await fs.writeFile(fixturePath, contents);
  const sourcePath = await fs.realpath(fixturePath);
  return { sourcePath, sourceStat: await fs.stat(sourcePath) };
}

function createCacheKey(source: {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}): string {
  const testApi = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.playbackTranscodeTestApi")
  ] as { createPlaybackTranscodeCacheKey?: (value: typeof source) => string } | undefined;
  if (!testApi?.createPlaybackTranscodeCacheKey) {
    throw new Error("playback transcode test API unavailable");
  }
  return testApi.createPlaybackTranscodeCacheKey(source);
}

describe("playback transcode policy", () => {
  it("keeps only cross-client containers native and closes both target recipes", () => {
    expect(playback.PLAYBACK_TRANSCODE_POLICY).toEqual({
      audio: {
        nativeMimeTypes: [
          "audio/aac",
          "audio/m4a",
          "audio/mp3",
          "audio/mp4",
          "audio/mpeg",
          "audio/wav",
          "audio/wave",
          "audio/x-m4a",
          "audio/x-wav",
        ],
        transcodeInputFormats: {
          "audio/aiff": "aiff",
          "audio/amr": "amr",
          "audio/amr-wb": "amr",
          "audio/flac": "flac",
          "audio/ogg": "ogg",
          "audio/opus": "ogg",
          "audio/vorbis": "ogg",
          "audio/webm": "matroska,webm",
          "audio/x-aiff": "aiff",
          "audio/x-caf": "caf",
          "audio/x-ms-wma": "asf",
        },
        target: { contentType: "audio/mp4", extension: ".m4a" },
      },
      video: {
        nativeMimeTypes: ["video/mp4"],
        transcodeInputFormats: {
          "video/avi": "avi",
          "video/flv": "flv",
          "video/matroska": "matroska,webm",
          "video/quicktime": "mov",
          "video/webm": "matroska,webm",
          "video/x-flv": "flv",
          "video/x-matroska": "matroska,webm",
          "video/x-ms-asf": "asf",
          "video/x-ms-wmv": "asf",
          "video/x-msvideo": "avi",
        },
        target: { contentType: "video/mp4", extension: ".mp4" },
      },
    });

    const audioPolicy = playback.PLAYBACK_TRANSCODE_POLICY.audio;
    const videoPolicy = playback.PLAYBACK_TRANSCODE_POLICY.video;
    expect(playback.resolvePlaybackMode("audio/mpeg", audioPolicy)).toBe("native");
    expect(playback.resolvePlaybackMode("audio/x-caf", audioPolicy)).toBe("transcode");
    expect(playback.resolvePlaybackMode("audio/amr", audioPolicy)).toBe("transcode");
    expect(playback.resolvePlaybackMode("audio/ogg", audioPolicy)).toBe("transcode");
    expect(playback.resolvePlaybackMode("video/mp4; codecs=avc1", videoPolicy)).toBe("native");
    expect(playback.resolvePlaybackMode("video/x-matroska", videoPolicy)).toBe("transcode");
    expect(playback.resolvePlaybackMode("video/webm", videoPolicy)).toBe("transcode");
    expect(playback.resolvePlaybackMode("video/x-playlist", videoPolicy)).toBeUndefined();
  });

  it("derives a stable cache key from path, size, and modification time", () => {
    const source = {
      path: "/media/clip.mkv",
      size: 1234,
      mtimeMs: 5678.25,
      ctimeMs: 5679.5,
      dev: 16,
      ino: 32,
    };
    const key = createCacheKey(source);

    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(createCacheKey(source)).toBe(key);
    expect(createCacheKey({ ...source, path: "/media/other.mkv" })).not.toBe(key);
    expect(createCacheKey({ ...source, size: 1235 })).not.toBe(key);
    expect(createCacheKey({ ...source, mtimeMs: 5679 })).not.toBe(key);
    expect(createCacheKey({ ...source, ctimeMs: 5680 })).not.toBe(key);
    expect(createCacheKey({ ...source, ino: 33 })).not.toBe(key);
  });
});

describe("resolvePlaybackTranscode", () => {
  it("single-flights concurrent requests and reuses the deterministic store entry", async () => {
    const source = await createSource("single-flight.mkv");
    let finishTranscode: (() => void) | undefined;
    const transcodeGate = new Promise<void>((resolve) => {
      finishTranscode = resolve;
    });
    runFfmpeg.mockImplementation(async (args: string[]) => {
      await transcodeGate;
      await fs.writeFile(args.at(-1) ?? "", "normalized-video");
      return "";
    });

    const params = {
      ...source,
      mimeType: "video/x-matroska",
      kind: "video" as const,
    };
    await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
      kind: "preparing",
    });
    await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
      kind: "preparing",
    });
    await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledOnce());
    finishTranscode?.();

    let resolved: Awaited<ReturnType<typeof playback.resolvePlaybackTranscode>> | undefined;
    await vi.waitFor(async () => {
      resolved = await playback.resolvePlaybackTranscode(params);
      expect(resolved.kind).toBe("transcoded");
    });
    expect(runFfmpeg).toHaveBeenCalledOnce();
    expect(resolved).toMatchObject({
      kind: "transcoded",
      contentType: "video/mp4",
      extension: ".mp4",
    });
    if (resolved?.kind !== "transcoded") {
      throw new Error("expected cached playback output");
    }
    expect(resolved.path).toContain(`${path.sep}media${path.sep}playback-transcode${path.sep}`);
    expect(await fs.readFile(resolved.path, "utf8")).toBe("normalized-video");
    expect(runFfmpeg.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "-max_alloc",
        String(256 * 1024 * 1024),
        "-filter_threads",
        "2",
        "-protocol_whitelist",
        "file",
        "-f",
        "matroska,webm",
        "-max_pixels",
        String(4096 * 4096),
        "-threads",
        "2",
        "-t",
        String(20 * 60),
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        "-fs",
        String(16 * 1024 * 1024 + 1),
      ]),
    );
  });

  it("remembers a failed ffmpeg attempt so the route can fall back to original bytes", async () => {
    const source = await createSource("failed.caf", "caff-source");
    runFfmpeg.mockRejectedValueOnce(new Error("ffmpeg unavailable"));
    const params = {
      ...source,
      mimeType: "audio/x-caf",
      kind: "audio" as const,
    };

    await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
      kind: "preparing",
    });
    await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "fallback",
      });
    });
  });

  it("keeps a saturated transcode pool retryable until capacity is available", async () => {
    const sources = await Promise.all([
      createSource("pool-first.mkv"),
      createSource("pool-second.mkv"),
      createSource("pool-third.mkv"),
    ]);
    const finishers: Array<() => Promise<void>> = [];
    runFfmpeg.mockImplementation(
      async (args: string[]) =>
        await new Promise<string>((resolve) => {
          finishers.push(async () => {
            await fs.writeFile(args.at(-1) ?? "", "normalized-video");
            resolve("");
          });
        }),
    );
    const params = sources.map(({ sourcePath, sourceStat }) => ({
      sourcePath,
      sourceStat,
      mimeType: "video/x-matroska",
      kind: "video" as const,
    }));

    await expect(playback.resolvePlaybackTranscode(params[0]!)).resolves.toEqual({
      kind: "preparing",
    });
    await expect(playback.resolvePlaybackTranscode(params[1]!)).resolves.toEqual({
      kind: "preparing",
    });
    await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledTimes(2));
    await expect(playback.resolvePlaybackTranscode(params[2]!)).resolves.toEqual({
      kind: "preparing",
    });
    expect(runFfmpeg).toHaveBeenCalledTimes(2);

    await finishers[0]?.();
    await vi.waitFor(async () => {
      await expect(playback.resolvePlaybackTranscode(params[2]!)).resolves.toEqual({
        kind: "preparing",
      });
      expect(runFfmpeg).toHaveBeenCalledTimes(3);
    });
    await Promise.all(finishers.slice(1).map(async (finish) => await finish()));
  });

  it("passes already portable media through without invoking ffmpeg", async () => {
    const source = await createSource("native.mp3", "ID3-native");

    await expect(
      playback.resolvePlaybackTranscode({
        ...source,
        mimeType: "audio/mpeg",
        kind: "audio",
      }),
    ).resolves.toEqual({ kind: "passthrough" });
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("falls back without invoking ffmpeg for media outside the closed demuxer table", async () => {
    const source = await createSource("playlist.m3u8", "https://internal.example/media.ts");

    await expect(
      playback.resolvePlaybackTranscode({
        ...source,
        mimeType: "audio/x-mpegurl",
        kind: "audio",
      }),
    ).resolves.toEqual({ kind: "fallback" });
    expect(runFfmpeg).not.toHaveBeenCalled();
  });
});
