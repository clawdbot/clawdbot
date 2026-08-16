import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProbeKind, MediaProbeResult } from "./media-probe.js";

const { runFfprobe } = vi.hoisted(() => ({
  runFfprobe: vi.fn(),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfprobe,
}));

let testDir = "";
let songPath = "";
let clipPath = "";
let voicePath = "";
let probeMediaFilesWithinBudget: typeof import("./media-probe.js").probeMediaFilesWithinBudget;
let probePlaybackMediaFileDescriptor: typeof import("./media-probe.js").probePlaybackMediaFileDescriptor;
let probeVideoDimensions: typeof import("./media-probe.js").probeVideoDimensions;

beforeAll(async () => {
  vi.resetModules();
  ({ probeMediaFilesWithinBudget, probePlaybackMediaFileDescriptor, probeVideoDimensions } =
    await import("./media-probe.js"));
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-probe-"));
  songPath = path.join(testDir, "song.mp3");
  clipPath = path.join(testDir, "clip.mp4");
  voicePath = path.join(testDir, "voice.ogg");
  await Promise.all([
    fs.writeFile(songPath, "song"),
    fs.writeFile(clipPath, "clip"),
    fs.writeFile(voicePath, "voice"),
  ]);
});

afterAll(async () => {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } finally {
    vi.doUnmock("./ffmpeg-exec.js");
    vi.resetModules();
  }
});

beforeEach(() => {
  runFfprobe.mockReset();
});

async function probeMediaFile(filePath: string, kind: MediaProbeKind): Promise<MediaProbeResult> {
  const [result] = await probeMediaFilesWithinBudget([{ filePath, kind }], {
    budgetMs: 3000,
    concurrency: 1,
    maxProbes: 1,
  });
  return result ?? {};
}

describe("probeMediaFile", () => {
  it("returns audio duration from one bounded file probe", async () => {
    runFfprobe.mockResolvedValueOnce(JSON.stringify({ format: { duration: "12.3456" } }));

    await expect(probeMediaFile(songPath, "audio")).resolves.toEqual({
      durationMs: 12_346,
    });
    expect(runFfprobe).toHaveBeenCalledOnce();
    expect(runFfprobe).toHaveBeenCalledWith(
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "fd",
        "-show_entries",
        "format=duration:stream=index,codec_type,codec_name,profile,pix_fmt,duration,width,height:stream_disposition=default,attached_pic",
        "-of",
        "json",
        "-fd",
        "0",
        "fd:",
      ],
      { stdinFileDescriptor: expect.any(Number), timeoutMs: expect.any(Number) },
    );
  });

  it("returns video duration and dimensions from the selected stream", async () => {
    runFfprobe.mockResolvedValueOnce(
      JSON.stringify({
        format: { duration: "10" },
        streams: [{ codec_type: "video", duration: "3.2", width: 720, height: 1280 }],
      }),
    );

    await expect(probeMediaFile(clipPath, "video")).resolves.toEqual({
      durationMs: 3200,
      width: 720,
      height: 1280,
    });
    expect(runFfprobe).toHaveBeenCalledOnce();
  });

  it("probes an inherited descriptor through stdin", async () => {
    runFfprobe.mockResolvedValueOnce(JSON.stringify({ format: { duration: "2" } }));

    await expect(probePlaybackMediaFileDescriptor(17, "audio")).resolves.toEqual({
      durationMs: 2000,
    });
    expect(runFfprobe).toHaveBeenCalledWith(expect.arrayContaining(["-fd", "0", "fd:"]), {
      stdinFileDescriptor: 17,
    });
  });

  it("returns duration and first audio/video codecs in one playback probe", async () => {
    runFfprobe.mockResolvedValueOnce(
      JSON.stringify({
        format: { duration: "3.25" },
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "H264",
            disposition: { default: 0, attached_pic: 1 },
          },
          {
            index: 2,
            codec_type: "video",
            codec_name: "HEVC",
            profile: "Main 10",
            pix_fmt: "yuv420p10le",
            duration: "3",
            width: 1920,
            height: 1080,
            disposition: { default: 1, attached_pic: 0 },
          },
          {
            index: 3,
            codec_type: "audio",
            codec_name: "AAC",
            duration: "4",
            disposition: { default: 1, attached_pic: 0 },
          },
        ],
      }),
    );

    await expect(probePlaybackMediaFileDescriptor(17, "video")).resolves.toEqual({
      durationMs: 4000,
      width: 1920,
      height: 1080,
      videoCodec: "hevc",
      videoProfile: "main 10",
      videoPixelFormat: "yuv420p10le",
      videoStreamIndex: 2,
      audioCodec: "aac",
      audioStreamIndex: 3,
    });
    expect(runFfprobe).toHaveBeenCalledOnce();
  });

  it("falls back to pipe input when older ffprobe lacks the fd protocol", async () => {
    runFfprobe
      .mockRejectedValueOnce(
        Object.assign(new Error("ffprobe failed"), { stderr: "fd:: Protocol not found" }),
      )
      .mockResolvedValueOnce(JSON.stringify({ format: { duration: "2" } }));

    await expect(probePlaybackMediaFileDescriptor(17, "audio")).resolves.toEqual({
      durationMs: 2000,
    });
    expect(runFfprobe).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(["-protocol_whitelist", "pipe", "pipe:0"]),
      { stdinFileDescriptor: 17 },
    );
  });

  it("uses stream duration when the container duration is absent", async () => {
    runFfprobe.mockResolvedValueOnce(
      JSON.stringify({ streams: [{ codec_type: "audio", duration: "1.5" }] }),
    );

    await expect(probeMediaFile(voicePath, "audio")).resolves.toEqual({
      durationMs: 1500,
    });
  });

  it("omits invalid fields and treats every probe failure as unknown metadata", async () => {
    runFfprobe.mockResolvedValueOnce(
      JSON.stringify({
        format: { duration: "N/A" },
        streams: [{ codec_type: "video", width: 0, height: 720 }],
      }),
    );
    await expect(probeMediaFile(clipPath, "video")).resolves.toEqual({});

    runFfprobe.mockRejectedValueOnce(new Error("missing ffprobe"));
    await expect(probeMediaFile(clipPath, "video")).resolves.toEqual({});

    runFfprobe.mockResolvedValueOnce("{");
    await expect(probeMediaFile(clipPath, "video")).resolves.toEqual({});
  });
});

describe("probeMediaFilesWithinBudget", () => {
  it("caps probes and leaves excess results empty", async () => {
    runFfprobe.mockResolvedValue(JSON.stringify({ format: { duration: "1" } }));
    const results = await probeMediaFilesWithinBudget(
      Array.from({ length: 10 }, () => ({ filePath: songPath, kind: "audio" as const })),
      { budgetMs: 3000, concurrency: 2, maxProbes: 8 },
    );

    expect(runFfprobe).toHaveBeenCalledTimes(8);
    expect(results.slice(0, 8).every((result) => result.durationMs === 1000)).toBe(true);
    expect(results.slice(8).every((result) => result.durationMs === undefined)).toBe(true);
    expect(runFfprobe.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: expect.any(Number) });
  });

  it("limits concurrent probes", async () => {
    let active = 0;
    let maxActive = 0;
    runFfprobe.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      active -= 1;
      return "{}";
    });

    await probeMediaFilesWithinBudget(
      Array.from({ length: 4 }, () => ({ filePath: songPath, kind: "audio" as const })),
      { budgetMs: 3000, concurrency: 2, maxProbes: 8 },
    );
    expect(maxActive).toBe(2);
  });

  it("stops launching probes after the batch budget expires", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(5000);
    try {
      const results = await probeMediaFilesWithinBudget([{ filePath: songPath, kind: "audio" }], {
        budgetMs: 3000,
        concurrency: 2,
        maxProbes: 8,
      });
      expect(runFfprobe).not.toHaveBeenCalled();
      expect(results).toEqual([{}]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("probeVideoDimensions", () => {
  it("keeps buffer callers on the canonical probe path", async () => {
    const buffer = Buffer.from("video");
    runFfprobe.mockResolvedValueOnce(
      JSON.stringify({ streams: [{ codec_type: "video", width: 720, height: 1280 }] }),
    );

    await expect(probeVideoDimensions(buffer)).resolves.toEqual({ width: 720, height: 1280 });
    expect(runFfprobe).toHaveBeenCalledWith(
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "pipe",
        "-show_entries",
        "format=duration:stream=index,codec_type,codec_name,profile,pix_fmt,duration,width,height:stream_disposition=default,attached_pic",
        "-of",
        "json",
        "pipe:0",
      ],
      { input: buffer },
    );
  });

  it("falls back to a seekable temp file when the pipe probe yields no dimensions", async () => {
    const buffer = Buffer.from("moov-at-end video");
    let probed: { args: string[]; content: Buffer } | undefined;
    runFfprobe.mockRejectedValueOnce(new Error("pipe:0: Invalid data found when processing input"));
    runFfprobe.mockImplementationOnce(async (args: string[]) => {
      probed = { args, content: await fs.readFile(args.at(-1) as string) };
      return JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080 }] });
    });

    await expect(probeVideoDimensions(buffer)).resolves.toEqual({ width: 1920, height: 1080 });
    expect(runFfprobe).toHaveBeenCalledTimes(2);
    expect(probed?.args).toEqual([
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-show_entries",
      "format=duration:stream=index,codec_type,codec_name,profile,pix_fmt,duration,width,height:stream_disposition=default,attached_pic",
      "-of",
      "json",
      expect.stringContaining("video-probe-"),
    ]);
    expect(probed?.content.equals(buffer)).toBe(true);
    const probedPath = probed?.args.at(-1) as string;
    await expect(fs.access(probedPath)).rejects.toThrow();
    await expect(fs.access(path.dirname(probedPath))).rejects.toThrow();
  });

  it("returns undefined and still cleans up when the temp-file probe fails too", async () => {
    const buffer = Buffer.from("not a video");
    const filePaths: string[] = [];
    runFfprobe.mockImplementation(async (args: string[]) => {
      const target = args.at(-1) as string;
      if (target !== "pipe:0") {
        filePaths.push(target);
      }
      throw new Error("Invalid data found when processing input");
    });

    await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();
    const failedPath = filePaths[0];
    expect(failedPath).toBeDefined();
    if (!failedPath) {
      return;
    }
    await expect(fs.access(failedPath)).rejects.toThrow();
    await expect(fs.access(path.dirname(failedPath))).rejects.toThrow();
  });

  it("carries the remaining probe budget into the temp-file retry", async () => {
    const buffer = Buffer.from("slow pipe video");
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      runFfprobe.mockImplementationOnce(async () => {
        now += 4000;
        throw new Error("pipe:0: Invalid data found when processing input");
      });
      runFfprobe.mockResolvedValueOnce(
        JSON.stringify({ streams: [{ codec_type: "video", width: 640, height: 480 }] }),
      );

      await expect(probeVideoDimensions(buffer)).resolves.toEqual({ width: 640, height: 480 });
      expect(runFfprobe).toHaveBeenCalledTimes(2);
      expect(runFfprobe).toHaveBeenLastCalledWith(expect.any(Array), { timeoutMs: 6000 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("skips the temp-file retry when the pipe probe exhausted the budget", async () => {
    const buffer = Buffer.from("timed out video");
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      runFfprobe.mockImplementationOnce(async () => {
        now += 10_000;
        throw new Error("ffprobe timed out");
      });

      await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();
      expect(runFfprobe).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps concurrent fallback probes isolated in separate workspaces", async () => {
    const bufferA = Buffer.from("video payload A");
    const bufferB = Buffer.from("video payload B");
    runFfprobe.mockImplementation(async (args: string[]) => {
      const target = args.at(-1) as string;
      if (target === "pipe:0") {
        throw new Error("Invalid data found when processing input");
      }
      const written = await fs.readFile(target);
      if (written.equals(bufferA)) {
        return JSON.stringify({ streams: [{ codec_type: "video", width: 100, height: 200 }] });
      }
      if (written.equals(bufferB)) {
        return JSON.stringify({ streams: [{ codec_type: "video", width: 300, height: 400 }] });
      }
      throw new Error(`unexpected probe payload at ${target}`);
    });

    const [a, b] = await Promise.all([
      probeVideoDimensions(bufferA),
      probeVideoDimensions(bufferB),
    ]);
    expect(a).toEqual({ width: 100, height: 200 });
    expect(b).toEqual({ width: 300, height: 400 });
  });
});
