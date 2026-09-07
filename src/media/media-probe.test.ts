import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProbeKind, MediaProbeResult } from "./media-probe.js";

const { runFfprobe } = vi.hoisted(() => ({
  runFfprobe: vi.fn<typeof import("./ffmpeg-exec.js").runFfprobe>(),
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
        "format=duration:stream=index,codec_type,codec_name,profile,pix_fmt,duration,width,height:stream_disposition=default,attached_pic:stream_side_data=rotation",
        "-of",
        "json",
        "-fd",
        "0",
        "fd:",
      ],
      { stdinFileDescriptor: expect.any(Number), timeoutMs: expect.any(Number) },
    );
  });

  it.each([
    { rotation: undefined, width: 720, height: 1280 },
    { rotation: 0, width: 720, height: 1280 },
    { rotation: 45, width: 720, height: 1280 },
    { rotation: 90, width: 1280, height: 720 },
    { rotation: -90, width: 1280, height: 720 },
    { rotation: -180, width: 720, height: 1280 },
  ])("returns display dimensions for selected stream rotation $rotation", async (testCase) => {
    runFfprobe.mockResolvedValue(
      JSON.stringify({
        format: { duration: "10" },
        streams: [
          {
            codec_type: "video",
            duration: "3.2",
            width: 720,
            height: 1280,
            side_data_list: [{ rotation: testCase.rotation }],
          },
        ],
      }),
    );

    await expect(probeMediaFile(clipPath, "video")).resolves.toEqual({
      durationMs: 3200,
      width: testCase.width,
      height: testCase.height,
    });
    await expect(probeVideoDimensions(Buffer.from("video"))).resolves.toEqual({
      width: testCase.width,
      height: testCase.height,
    });
    await expect(probePlaybackMediaFileDescriptor(17, "video")).resolves.toMatchObject({
      width: 720,
      height: 1280,
    });
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

  it.each([
    ["fd protocol missing", "fd:: Protocol not found"],
    [
      "fd option unrecognized",
      "Unrecognized option 'fd'.\nError splitting the argument list: Option not found",
    ],
    // ffprobe 4.4 (Ubuntu 22.04) and 5.x report the `-fd` option this way.
    ["fd option value rejected", "Failed to set value '0' for option 'fd': Option not found"],
  ])(
    "falls back to pipe input when older ffprobe lacks fd support (%s)",
    async (_label, stderr) => {
      runFfprobe
        .mockRejectedValueOnce(Object.assign(new Error("ffprobe failed"), { stderr }))
        .mockResolvedValueOnce(JSON.stringify({ format: { duration: "2" } }));

      await expect(probePlaybackMediaFileDescriptor(17, "audio")).resolves.toEqual({
        durationMs: 2000,
      });
      expect(runFfprobe).toHaveBeenNthCalledWith(
        2,
        expect.arrayContaining(["-protocol_whitelist", "pipe", "pipe:0"]),
        { stdinFileDescriptor: 17 },
      );
    },
  );

  it.each([
    "Failed to set value '0' for option 'threads': Option not found",
    "Failed to set value '0' for option 'fdfoo': Option not found",
  ])("does not retry an unrelated ffprobe option failure: %s", async (stderr) => {
    runFfprobe.mockRejectedValue(Object.assign(new Error("ffprobe failed"), { stderr }));

    await expect(probePlaybackMediaFileDescriptor(17, "audio")).resolves.toBeNull();
    expect(runFfprobe).toHaveBeenCalledOnce();
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

  it("keeps completed metadata when the shared batch budget expires", async () => {
    const nowSpy = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValue(4000);
    runFfprobe.mockResolvedValue(JSON.stringify({ format: { duration: "1" } }));
    try {
      const results = await probeMediaFilesWithinBudget(
        Array.from({ length: 4 }, () => ({ filePath: songPath, kind: "audio" as const })),
        { budgetMs: 3000, concurrency: 2, maxProbes: 8 },
      );
      expect(runFfprobe).toHaveBeenCalledTimes(2);
      expect(results).toEqual([{ durationMs: 1000 }, { durationMs: 1000 }, {}, {}]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([60_000, -60_000])(
    "keeps the batch budget through a %s ms wall-clock step",
    async (stepMs) => {
      let elapsedMs = 0;
      let offset = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => 1000 + elapsedMs + offset);
      const monotonicClock = vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
      runFfprobe.mockImplementation(async () => {
        elapsedMs += 250;
        offset = stepMs;
        return JSON.stringify({ format: { duration: "1" } });
      });
      try {
        const results = await probeMediaFilesWithinBudget(
          Array.from({ length: 4 }, () => ({ filePath: songPath, kind: "audio" as const })),
          { budgetMs: 3000, concurrency: 2, maxProbes: 4 },
        );
        expect(runFfprobe).toHaveBeenCalledTimes(4);
        expect(results).toEqual(Array.from({ length: 4 }, () => ({ durationMs: 1000 })));
        expect(runFfprobe.mock.calls.map(([, options]) => options?.timeoutMs)).toEqual([
          3000, 3000, 2500, 2500,
        ]);
      } finally {
        monotonicClock.mockRestore();
        clock.mockRestore();
      }
    },
  );
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
        "format=duration:stream=index,codec_type,codec_name,profile,pix_fmt,duration,width,height:stream_disposition=default,attached_pic:stream_side_data=rotation",
        "-of",
        "json",
        "pipe:0",
      ],
      { input: buffer },
    );
  });
});
