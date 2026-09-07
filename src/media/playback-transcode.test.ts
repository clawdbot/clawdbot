import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import type { PlaybackMediaProbeResult } from "./media-probe.js";
import {
  settlePlaybackTranscodeJobsForTest,
  waitForPlaybackTranscodeJobsForTest,
} from "./playback-transcode.test-support.js";

const { playbackWarn, probePlaybackMediaFileDescriptor, runFfmpeg } = vi.hoisted(() => ({
  playbackWarn: vi.fn(),
  probePlaybackMediaFileDescriptor: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: (subsystem: string) => ({ subsystem, warn: playbackWarn }),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfmpeg,
}));

vi.mock("./media-probe.js", () => ({
  probePlaybackMediaFileDescriptor,
}));

let playback: typeof import("./playback-transcode.js");
let tempHome: TempHomeEnv;

beforeAll(async () => {
  vi.resetModules();
  tempHome = await createTempHomeEnv("openclaw-playback-transcode-");
  playback = await import("./playback-transcode.js");
});

afterAll(async () => {
  try {
    await tempHome.restore();
  } finally {
    vi.doUnmock("./ffmpeg-exec.js");
    vi.doUnmock("./media-probe.js");
    vi.resetModules();
  }
});

beforeEach(() => {
  playbackWarn.mockReset();
  runFfmpeg.mockReset();
  probePlaybackMediaFileDescriptor.mockReset();
  probePlaybackMediaFileDescriptor.mockImplementation(async (_fd: number, kind: string) =>
    kind === "audio"
      ? { durationMs: 1000, audioCodec: "pcm_s16le", audioStreamIndex: 0 }
      : {
          durationMs: 1000,
          videoCodec: "vp9",
          videoStreamIndex: 0,
          audioCodec: "opus",
          audioStreamIndex: 1,
        },
  );
});

async function createSource(fileName: string, contents = "source") {
  const fixturePath = path.join(tempHome.home, fileName);
  await fs.writeFile(fixturePath, contents);
  const sourcePath = await fs.realpath(fixturePath);
  return { sourcePath, sourceStat: await fs.stat(sourcePath) };
}

// Supplied probe facts only need source identity; conversion cases keep real files.
function createSourceMetadata(fileName: string) {
  return {
    sourcePath: path.join(tempHome.home, fileName),
    sourceStat: { size: 6, mtimeMs: 1, ctimeMs: 1, dev: 1, ino: 1 },
  };
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
  it.each([
    ["audio/m4a", "audio", "native", "aac"],
    ["audio/mp3", "audio", "native", "mp3"],
    ["audio/mp4", "audio", "native", "aac"],
    ["audio/mpeg", "audio", "native", "mp3"],
    ["audio/wav", "audio", "native", "pcm_s16le"],
    ["audio/wave", "audio", "native", "pcm_s16le"],
    ["audio/x-m4a", "audio", "native", "aac"],
    ["audio/x-wav", "audio", "native", "pcm_s16le"],
    ["audio/aac", "audio", "transcode", "aac"],
    ["audio/aiff", "audio", "transcode", "adpcm_ima_qt"],
    ["audio/amr", "audio", "transcode", "amr_nb"],
    ["audio/amr-wb", "audio", "transcode", "amr_wb"],
    ["audio/flac", "audio", "transcode", "flac"],
    ["audio/ogg", "audio", "transcode", "vorbis"],
    ["audio/opus", "audio", "transcode", "opus"],
    ["audio/vorbis", "audio", "transcode", "vorbis"],
    ["audio/webm", "audio", "transcode", "opus"],
    ["audio/x-aiff", "audio", "transcode", "pcm_s16be"],
    ["audio/x-caf", "audio", "transcode", "pcm_s16le"],
    ["audio/x-ms-asf", "audio", "transcode", "wmav2"],
    ["audio/x-ms-wma", "audio", "transcode", "wmav2"],
    ["video/mp4", "video", "native", "h264"],
    ["video/avi", "video", "transcode", "mpeg4"],
    ["video/vnd.avi", "video", "transcode", "mpeg4"],
    ["video/flv", "video", "transcode", "flv1"],
    ["video/matroska", "video", "transcode", "vp9"],
    ["video/quicktime", "video", "transcode", "prores"],
    ["video/webm", "video", "transcode", "vp9"],
    ["video/x-flv", "video", "transcode", "flv1"],
    ["video/x-matroska", "video", "transcode", "vp9"],
    ["video/x-ms-asf", "video", "transcode", "wmv3"],
    ["video/x-ms-wmv", "video", "transcode", "wmv3"],
    ["video/x-msvideo", "video", "transcode", "mpeg4"],
  ] as const)(
    "classifies accepted $0 $1 as $2 through the public source resolver",
    async (mimeType, kind, expected, codec) => {
      const source = createSourceMetadata(`${mimeType.replaceAll("/", "-")}-${codec}`);
      const probe =
        kind === "audio"
          ? { durationMs: 1000, audioCodec: codec, audioStreamIndex: 0 }
          : {
              durationMs: 1000,
              videoCodec: codec,
              videoProfile: codec === "h264" ? "high" : undefined,
              videoPixelFormat: codec === "h264" ? "yuv420p" : undefined,
              videoStreamIndex: 0,
            };

      await expect(
        playback.resolvePlaybackModeForSource({
          ...source,
          mimeType,
          kind,
          probe,
        }),
      ).resolves.toBe(expected);
    },
  );

  it.each([
    ["audio/m4a", "audio", "mov"],
    ["audio/mpeg", "audio", "mp3"],
    ["audio/mp4", "audio", "mov"],
    ["audio/wav", "audio", "wav"],
    ["audio/wave", "audio", "wav"],
    ["audio/x-m4a", "audio", "mov"],
    ["audio/x-wav", "audio", "wav"],
    ["audio/aac", "audio", "aac"],
    ["audio/aiff", "audio", "aiff"],
    ["audio/amr", "audio", "amr"],
    ["audio/amr-wb", "audio", "amr"],
    ["audio/flac", "audio", "flac"],
    ["audio/ogg", "audio", "ogg"],
    ["audio/opus", "audio", "ogg"],
    ["audio/vorbis", "audio", "ogg"],
    ["audio/webm", "audio", "matroska,webm"],
    ["audio/x-aiff", "audio", "aiff"],
    ["audio/x-caf", "audio", "caf"],
    ["audio/x-ms-asf", "audio", "asf"],
    ["audio/x-ms-wma", "audio", "asf"],
    ["video/mp4", "video", "mov"],
    ["video/avi", "video", "avi"],
    ["video/vnd.avi", "video", "avi"],
    ["video/flv", "video", "flv"],
    ["video/matroska", "video", "matroska,webm"],
    ["video/quicktime", "video", "mov"],
    ["video/webm", "video", "matroska,webm"],
    ["video/x-flv", "video", "flv"],
    ["video/x-matroska", "video", "matroska,webm"],
    ["video/x-ms-asf", "video", "asf"],
    ["video/x-ms-wmv", "video", "asf"],
    ["video/x-msvideo", "video", "avi"],
  ] as const)(
    "uses the $2 demuxer for accepted $0 conversion",
    async (mimeType, kind, inputFormat) => {
      const source = await createSource(`demux-${mimeType.replaceAll("/", "-")}`);
      const probe =
        kind === "audio"
          ? { durationMs: 1000, audioCodec: "opus", audioStreamIndex: 0 }
          : { durationMs: 1000, videoCodec: "hevc", videoStreamIndex: 0 };
      runFfmpeg.mockImplementationOnce(async (args: string[]) => {
        await fs.writeFile(args.at(-1) ?? "", `normalized-${kind}`);
        return "";
      });

      await expect(
        playback.resolvePlaybackTranscode({ ...source, mimeType, kind, probe }),
      ).resolves.toEqual({ kind: "preparing" });
      await waitForPlaybackTranscodeJobsForTest("all");

      const ffmpegArgs = runFfmpeg.mock.calls[0]?.[0] as string[];
      const inputFormatIndex = ffmpegArgs.indexOf("-f");
      expect(ffmpegArgs[inputFormatIndex + 1]).toBe(inputFormat);
      await expect(
        playback.resolvePlaybackTranscode({ ...source, mimeType, kind, probe }),
      ).resolves.toMatchObject(
        kind === "audio"
          ? { kind: "transcoded", contentType: "audio/mp4", extension: ".m4a" }
          : { kind: "transcoded", contentType: "video/mp4", extension: ".mp4" },
      );
    },
  );

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
  it("falls back before ffmpeg when source duration exceeds the transcode limit", async () => {
    const source = await createSource("long-video.mkv");
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 20 * 60 * 1000 + 1,
      videoCodec: "hevc",
      videoStreamIndex: 0,
    });

    await expect(
      playback.resolvePlaybackTranscode({
        ...source,
        mimeType: "video/x-matroska",
        kind: "video",
      }),
    ).resolves.toEqual({ kind: "fallback" });
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("scopes cached codec classification by media kind and MIME", async () => {
    const source = createSourceMetadata("dual-track.mp4");

    await expect(
      playback.resolvePlaybackModeForSource({
        ...source,
        mimeType: "audio/mp4",
        kind: "audio",
        probe: { durationMs: 1000, audioCodec: "aac", audioStreamIndex: 1 },
      }),
    ).resolves.toBe("native");
    await expect(
      playback.resolvePlaybackModeForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
        probe: {
          durationMs: 1000,
          videoCodec: "hevc",
          videoStreamIndex: 0,
          audioCodec: "aac",
          audioStreamIndex: 1,
        },
      }),
    ).resolves.toBe("transcode");
  });

  it("does not advertise transcode for a source over the media byte cap", async () => {
    const source = createSourceMetadata("oversized-meta.mp4");
    const { mtimeMs, ctimeMs, dev, ino } = source.sourceStat;
    const sourceStat = { size: 16 * 1024 * 1024 + 1, mtimeMs, ctimeMs, dev, ino };

    await expect(
      playback.resolvePlaybackModeForSource({
        sourcePath: source.sourcePath,
        sourceStat,
        mimeType: "video/mp4",
        kind: "video",
        probe: { durationMs: 1000, videoCodec: "hevc", videoStreamIndex: 0 },
      }),
    ).resolves.toBeUndefined();
    await expect(
      playback.resolvePlaybackModeForSource({
        sourcePath: source.sourcePath,
        sourceStat,
        mimeType: "video/mp4",
        kind: "video",
        probe: {
          durationMs: 1000,
          videoCodec: "h264",
          videoProfile: "high",
          videoPixelFormat: "yuv420p",
          videoStreamIndex: 0,
        },
      }),
    ).resolves.toBe("native");
  });

  it("transcodes nonportable H.264 profiles and pixel formats", async () => {
    const source = createSourceMetadata("high-10.mp4");

    await expect(
      playback.resolvePlaybackModeForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
        probe: {
          durationMs: 1000,
          videoCodec: "h264",
          videoProfile: "high 10",
          videoPixelFormat: "yuv420p10le",
          videoStreamIndex: 0,
        },
      }),
    ).resolves.toBe("transcode");
  });

  it("transcodes known-incompatible MP4 audio when H.264 profile facts are unknown", async () => {
    const source = createSourceMetadata("unknown-profile-opus.mp4");

    await expect(
      playback.resolvePlaybackModeForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
        probe: {
          durationMs: 1000,
          videoCodec: "h264",
          videoStreamIndex: 0,
          audioCodec: "opus",
          audioStreamIndex: 1,
        },
      }),
    ).resolves.toBe("transcode");
  });

  it("does not cache native when a selected audio stream has an unknown codec", async () => {
    const source = createSourceMetadata("unknown-audio.mp4");

    await expect(
      playback.resolvePlaybackModeForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
        probe: {
          durationMs: 1000,
          videoCodec: "h264",
          videoProfile: "high",
          videoPixelFormat: "yuv420p",
          videoStreamIndex: 0,
          audioStreamIndex: 1,
        },
      }),
    ).resolves.toBe("native");
    await expect(
      playback.resolvePlaybackModeForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
        probe: {
          durationMs: 1000,
          videoCodec: "h264",
          videoProfile: "high",
          videoPixelFormat: "yuv420p",
          videoStreamIndex: 0,
          audioCodec: "opus",
          audioStreamIndex: 1,
        },
      }),
    ).resolves.toBe("transcode");
  });

  it("does not cache an inconclusive native codec probe", async () => {
    const source = await createSource("probe-retry.mp4");
    const transcodeGate = createDeferred();
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce(null).mockResolvedValueOnce({
      durationMs: 1000,
      videoCodec: "hevc",
      videoStreamIndex: 0,
      audioCodec: "aac",
      audioStreamIndex: 1,
    });
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await transcodeGate.promise;
      await fs.writeFile(args.at(-1) ?? "", "normalized-video");
      return "";
    });
    const params = {
      ...source,
      mimeType: "video/mp4",
      kind: "video" as const,
    };

    try {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "passthrough",
      });
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledOnce());
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledTimes(2);
      transcodeGate.resolve();
      await vi.waitFor(async () => {
        await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
          kind: "transcoded",
        });
      });
    } finally {
      transcodeGate.resolve();
      await settlePlaybackTranscodeJobsForTest();
    }
  });

  it("single-flights concurrent codec inspections for the same source", async () => {
    const source = await createSource("inspection-single-flight.mp4");
    const probeGate = createDeferred<PlaybackMediaProbeResult>();
    probePlaybackMediaFileDescriptor.mockImplementationOnce(async () => await probeGate.promise);
    const params = {
      ...source,
      mimeType: "video/mp4",
      kind: "video" as const,
    };

    const nativeProbe: PlaybackMediaProbeResult = {
      durationMs: 1000,
      videoCodec: "h264",
      videoProfile: "high",
      videoPixelFormat: "yuv420p",
      videoStreamIndex: 0,
      audioCodec: "aac",
      audioStreamIndex: 1,
    };
    const first = playback.resolvePlaybackModeForSource(params);
    const second = playback.resolvePlaybackModeForSource(params);
    try {
      await vi.waitFor(() => expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledOnce());
      probeGate.resolve(nativeProbe);
      await expect(Promise.all([first, second])).resolves.toEqual(["native", "native"]);
    } finally {
      probeGate.resolve(nativeProbe);
      await Promise.allSettled([first, second]);
    }
  });

  it("fails closed at inspection capacity without blocking supplied probe facts", async () => {
    const sources = await Promise.all([
      createSource("inspection-capacity-first.mp4"),
      createSource("inspection-capacity-second.mp4"),
      createSource("inspection-capacity-supplied.mp4"),
      createSource("inspection-capacity-fallback.mp4"),
    ]);
    const probeGate = createDeferred<PlaybackMediaProbeResult>();
    probePlaybackMediaFileDescriptor.mockImplementation(async () => await probeGate.promise);
    const makeParams = (index: number) => ({
      ...sources[index]!,
      mimeType: "video/mp4",
      kind: "video" as const,
    });

    const nativeProbe: PlaybackMediaProbeResult = {
      durationMs: 1000,
      videoCodec: "h264",
      videoProfile: "high",
      videoPixelFormat: "yuv420p",
      videoStreamIndex: 0,
    };
    const first = playback.resolvePlaybackModeForSource(makeParams(0));
    const second = playback.resolvePlaybackModeForSource(makeParams(1));
    try {
      await vi.waitFor(() => expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledTimes(2));
      await expect(
        playback.resolvePlaybackModeForSource({
          ...makeParams(2),
          probe: { durationMs: 1000, videoCodec: "hevc", videoStreamIndex: 0 },
        }),
      ).resolves.toBe("transcode");
      await expect(playback.resolvePlaybackModeForSource(makeParams(3))).resolves.toBeUndefined();
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledTimes(2);

      probeGate.resolve(nativeProbe);
      await expect(Promise.all([first, second])).resolves.toEqual(["native", "native"]);
    } finally {
      probeGate.resolve(nativeProbe);
      await Promise.allSettled([first, second]);
    }
  });

  it("does not cache an inconclusive duration probe for an exotic container", async () => {
    const source = await createSource("duration-retry.mkv");
    probePlaybackMediaFileDescriptor
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ durationMs: 1000, videoCodec: "hevc", videoStreamIndex: 0 });
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", "normalized-video");
      return "";
    });
    const params = {
      ...source,
      mimeType: "video/x-matroska",
      kind: "video" as const,
    };

    await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
      kind: "fallback",
    });
    await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
      kind: "preparing",
    });
    await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
        kind: "transcoded",
      });
    });
  });

  it("transcodes HEVC-in-MP4 and reuses its cached codec classification", async () => {
    const source = await createSource("hevc.mp4");
    const transcodeGate = createDeferred();
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 1000,
      videoCodec: "hevc",
      videoStreamIndex: 2,
      audioCodec: "aac",
      audioStreamIndex: 3,
    });
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await transcodeGate.promise;
      await fs.writeFile(args.at(-1) ?? "", "normalized-video");
      return "";
    });
    const params = {
      ...source,
      mimeType: "video/mp4",
      kind: "video" as const,
    };

    try {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledOnce());
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledOnce();
      transcodeGate.resolve();
      await vi.waitFor(async () => {
        await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
          kind: "transcoded",
        });
      });
      expect(runFfmpeg.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining(["-f", "mov", "-map", "0:2", "-map", "0:3", "-c:v", "libx264"]),
      );
    } finally {
      transcodeGate.resolve();
      await settlePlaybackTranscodeJobsForTest();
    }
  });

  it("single-flights MIME aliases that target the same cached rendition", async () => {
    const source = await createSource("alias-audio.mp4");
    const transcodeGate = createDeferred();
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await transcodeGate.promise;
      await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
      return "";
    });
    const base = {
      ...source,
      kind: "audio" as const,
      probe: { durationMs: 1000, audioCodec: "opus", audioStreamIndex: 0 },
    };

    try {
      await expect(
        Promise.all([
          playback.resolvePlaybackTranscode({ ...base, mimeType: "audio/mp4" }),
          playback.resolvePlaybackTranscode({ ...base, mimeType: "audio/x-m4a" }),
        ]),
      ).resolves.toEqual([{ kind: "preparing" }, { kind: "preparing" }]);
      await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledOnce());
      transcodeGate.resolve();
      await vi.waitFor(async () => {
        await expect(
          playback.resolvePlaybackTranscode({ ...base, mimeType: "audio/mp4" }),
        ).resolves.toMatchObject({
          kind: "transcoded",
          contentType: "audio/mp4",
          extension: ".m4a",
        });
      });
    } finally {
      transcodeGate.resolve();
      await settlePlaybackTranscodeJobsForTest();
    }
  });

  it("single-flights concurrent requests and reuses the deterministic store entry", async () => {
    const source = await createSource("single-flight.mkv");
    const transcodeGate = createDeferred();
    runFfmpeg.mockImplementation(async (args: string[]) => {
      await transcodeGate.promise;
      await fs.writeFile(args.at(-1) ?? "", "normalized-video");
      return "";
    });

    const params = {
      ...source,
      mimeType: "video/x-matroska",
      kind: "video" as const,
    };
    try {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledOnce());
      transcodeGate.resolve();

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
      expect(path.basename(resolved.path)).toMatch(/^v2-[a-f0-9]{64}\.mp4$/u);
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
          "-map",
          "0:0",
          "-map",
          "0:1",
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
    } finally {
      transcodeGate.resolve();
      await settlePlaybackTranscodeJobsForTest();
    }
  });

  it("retries failed ffmpeg jobs after the bounded cooldown", async () => {
    const source = await createSource("failed.caf", "caff-source");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
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
      nowSpy.mockReturnValue(61_001);
      runFfmpeg.mockImplementationOnce(async (args: string[]) => {
        await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
        return "";
      });
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => {
        await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
          kind: "transcoded",
        });
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    {
      kind: "audio",
      fileName: "clock-rollback.caf",
      mimeType: "audio/x-caf",
      phase: "before resolution",
      duringCheck: false,
    },
    {
      kind: "video",
      fileName: "clock-rollback.webm",
      mimeType: "video/webm",
      phase: "before resolution",
      duringCheck: false,
    },
    {
      kind: "audio",
      fileName: "clock-rollback-during-check.caf",
      mimeType: "audio/x-caf",
      phase: "during cooldown check",
      duringCheck: true,
    },
    {
      kind: "video",
      fileName: "clock-rollback-during-check.webm",
      mimeType: "video/webm",
      phase: "during cooldown check",
      duringCheck: true,
    },
  ] as const)(
    "retries failed $kind transcodes when the wall clock moves backward $phase",
    async (media) => {
      const source = await createSource(media.fileName);
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(120_000);
      const params = { ...source, mimeType: media.mimeType, kind: media.kind };

      try {
        runFfmpeg.mockRejectedValueOnce(new Error("ffmpeg temporarily unavailable"));
        await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
          kind: "preparing",
        });
        await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledOnce());
        await vi.waitFor(async () => {
          await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
            kind: "fallback",
          });
        });

        nowSpy.mockReturnValue(1_000);
        if (media.duringCheck) {
          nowSpy.mockReturnValueOnce(180_001);
        }
        runFfmpeg.mockImplementationOnce(async (args: string[]) => {
          await fs.writeFile(args.at(-1) ?? "", `normalized-${media.kind}`);
          return "";
        });

        await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
          kind: "preparing",
        });
        await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledTimes(2));
        await vi.waitFor(async () => {
          await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
            kind: "transcoded",
          });
        });
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  it("warns once when the same transcode operation fails across cooldown retries", async () => {
    const source = await createSource("warn-failed.caf", "caff-source");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    runFfmpeg.mockRejectedValue(new Error("ffmpeg unavailable"));
    const params = {
      ...source,
      mimeType: "audio/x-caf",
      kind: "audio" as const,
    };

    try {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await vi.waitFor(() => expect(playbackWarn).toHaveBeenCalledOnce());
      expect(playbackWarn).toHaveBeenCalledWith(
        expect.stringContaining(`${source.sourcePath}: ffmpeg unavailable`),
      );

      nowSpy.mockReturnValue(61_001);
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await vi.waitFor(() => expect(runFfmpeg).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => {
        await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
          kind: "fallback",
        });
      });
      expect(playbackWarn).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps a saturated transcode pool retryable until capacity is available", async () => {
    const sources = await Promise.all([
      createSource("pool-first.mkv"),
      createSource("pool-second.mkv"),
      createSource("pool-third.mkv"),
    ]);
    const starts = sources.map(() => createDeferred());
    const releases = sources.map(() => createDeferred());
    let nextJobIndex = 0;
    runFfmpeg.mockImplementation(async (args: string[]) => {
      const index = nextJobIndex++;
      starts[index]!.resolve();
      await releases[index]!.promise;
      await fs.writeFile(args.at(-1) ?? "", "normalized-video");
      return "";
    });
    const params = sources.map(({ sourcePath, sourceStat }) => ({
      sourcePath,
      sourceStat,
      mimeType: "video/x-matroska",
      kind: "video" as const,
    }));

    try {
      await expect(playback.resolvePlaybackTranscode(params[0]!)).resolves.toEqual({
        kind: "preparing",
      });
      await expect(playback.resolvePlaybackTranscode(params[1]!)).resolves.toEqual({
        kind: "preparing",
      });
      await Promise.all(starts.slice(0, 2).map(async ({ promise }) => await promise));
      expect(runFfmpeg).toHaveBeenCalledTimes(2);
      await expect(playback.resolvePlaybackTranscode(params[2]!)).resolves.toEqual({
        kind: "preparing",
      });
      expect(runFfmpeg).toHaveBeenCalledTimes(2);

      const capacityAvailable = waitForPlaybackTranscodeJobsForTest("next");
      releases[0]!.resolve();
      await expect(capacityAvailable).resolves.toBe(2);
      await expect(playback.resolvePlaybackTranscode(params[2]!)).resolves.toEqual({
        kind: "preparing",
      });
      await starts[2]!.promise;
      expect(runFfmpeg).toHaveBeenCalledTimes(3);
      const remainingJobs = waitForPlaybackTranscodeJobsForTest("all");
      for (const release of releases.slice(1)) {
        release.resolve();
      }
      await expect(remainingJobs).resolves.toBe(2);
      await expect(
        Promise.all(params.map(async (param) => await playback.resolvePlaybackTranscode(param))),
      ).resolves.toEqual([
        expect.objectContaining({ kind: "transcoded" }),
        expect.objectContaining({ kind: "transcoded" }),
        expect.objectContaining({ kind: "transcoded" }),
      ]);
    } finally {
      for (const release of releases) {
        release.resolve();
      }
      await settlePlaybackTranscodeJobsForTest();
    }
  });

  it("passes already portable media through without invoking ffmpeg", async () => {
    const source = await createSource("native.mp3", "ID3-native");
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 1000,
      audioCodec: "mp3",
      audioStreamIndex: 0,
    });

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
