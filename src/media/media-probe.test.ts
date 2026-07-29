import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  probeMediaFileDescriptor,
  probeMediaFilesWithinBudget,
  probeVideoDimensions,
} from "./media-probe.js";
import type { MediaProbeKind, MediaProbeResult } from "./media-probe.js";

const { runFfprobe, withTempWorkspace, resolvePreferredOpenClawTmpDir } = vi.hoisted(() => ({
  runFfprobe: vi.fn(),
  withTempWorkspace: vi.fn(),
  resolvePreferredOpenClawTmpDir: vi.fn(),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfprobe,
}));

vi.mock("../infra/private-temp-workspace.js", () => ({
  withTempWorkspace,
}));

vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir,
}));

let testDir = "";
let songPath = "";
let clipPath = "";
let voicePath = "";

beforeAll(async () => {
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
  await fs.rm(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  runFfprobe.mockReset();
  resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw");
  // Write a real seekable file so probeVideoDimensions can fs.open it (same
  // path production uses after withTempWorkspace.write).
  withTempWorkspace.mockImplementation(async (_opts, run) => {
    const workspace = {
      write: vi.fn(async (name: string, buffer: Buffer) => {
        const filePath = path.join(testDir, name);
        await fs.writeFile(filePath, buffer);
        return filePath;
      }),
    };
    return await run(workspace);
  });
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
        "-select_streams",
        "a:0",
        "-protocol_whitelist",
        "fd",
        "-show_entries",
        "format=duration:stream=duration,width,height",
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
        format: { duration: "3.25" },
        streams: [{ duration: "3.2", width: 720, height: 1280 }],
      }),
    );

    await expect(probeMediaFile(clipPath, "video")).resolves.toEqual({
      durationMs: 3250,
      width: 720,
      height: 1280,
    });
    expect(runFfprobe).toHaveBeenCalledOnce();
  });

  it("probes an inherited descriptor through stdin", async () => {
    runFfprobe.mockResolvedValueOnce(JSON.stringify({ format: { duration: "2" } }));

    await expect(probeMediaFileDescriptor(17, "audio")).resolves.toEqual({ durationMs: 2000 });
    expect(runFfprobe).toHaveBeenCalledWith(expect.arrayContaining(["-fd", "0", "fd:"]), {
      stdinFileDescriptor: 17,
    });
  });

  it("falls back to pipe input when older ffprobe lacks the fd protocol", async () => {
    runFfprobe
      .mockRejectedValueOnce(
        Object.assign(new Error("ffprobe failed"), { stderr: "fd:: Protocol not found" }),
      )
      .mockResolvedValueOnce(JSON.stringify({ format: { duration: "2" } }));

    await expect(probeMediaFileDescriptor(17, "audio")).resolves.toEqual({ durationMs: 2000 });
    expect(runFfprobe).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(["-protocol_whitelist", "pipe", "pipe:0"]),
      { stdinFileDescriptor: 17 },
    );
  });

  it("uses stream duration when the container duration is absent", async () => {
    runFfprobe.mockResolvedValueOnce(JSON.stringify({ streams: [{ duration: "1.5" }] }));

    await expect(probeMediaFile(voicePath, "audio")).resolves.toEqual({
      durationMs: 1500,
    });
  });

  it("omits invalid fields and treats every probe failure as unknown metadata", async () => {
    runFfprobe.mockResolvedValueOnce(
      JSON.stringify({ format: { duration: "N/A" }, streams: [{ width: 0, height: 720 }] }),
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
  it("writes buffer to seekable temp file then probes path", async () => {
    const buffer = Buffer.from("video");
    let write: ReturnType<typeof vi.fn> | undefined;
    withTempWorkspace.mockImplementationOnce(async (_opts, run) => {
      write = vi.fn(async (name: string, data: Buffer) => {
        const filePath = path.join(testDir, name);
        await fs.writeFile(filePath, data);
        return filePath;
      });
      return await run({ write });
    });
    runFfprobe.mockResolvedValueOnce(JSON.stringify({ streams: [{ width: 720, height: 1280 }] }));

    await expect(probeVideoDimensions(buffer)).resolves.toEqual({ width: 720, height: 1280 });

    expect(write).toHaveBeenCalledWith("video.bin", buffer);
    expect(withTempWorkspace).toHaveBeenCalledWith(
      {
        rootDir: "/tmp/openclaw",
        prefix: "openclaw-ffprobe-",
      },
      expect.any(Function),
    );
    expect(runFfprobe).toHaveBeenCalledWith(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-protocol_whitelist",
        "fd",
        "-show_entries",
        "format=duration:stream=duration,width,height",
        "-of",
        "json",
        "-fd",
        "0",
        "fd:",
      ],
      { stdinFileDescriptor: expect.any(Number) },
    );
  });

  it("falls back when ffprobe fails or returns malformed output", async () => {
    const buffer = Buffer.from("video");

    runFfprobe.mockRejectedValueOnce(new Error("missing ffprobe"));
    await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();

    runFfprobe.mockResolvedValueOnce("{");
    await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();
  });

  it("falls back when the temp workspace write rejects", async () => {
    withTempWorkspace.mockRejectedValueOnce(new Error("disk full"));
    await expect(probeVideoDimensions(Buffer.from("video"))).resolves.toBeUndefined();
  });
});
