import { describe, expect, it, vi } from "vitest";

const { runFfprobe } = vi.hoisted(() => ({
  runFfprobe: vi.fn(),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfprobe,
}));

const { parseFfprobeVideoDimensions, probeVideoDimensions } = await import("./video-dimensions.js");

describe("parseFfprobeVideoDimensions", () => {
  it("returns positive integer dimensions from ffprobe JSON", () => {
    expect(
      parseFfprobeVideoDimensions(JSON.stringify({ streams: [{ width: 720, height: 1280 }] })),
    ).toEqual({ width: 720, height: 1280 });
  });

  it("ignores missing or invalid dimensions", () => {
    expect(parseFfprobeVideoDimensions(JSON.stringify({ streams: [] }))).toBeUndefined();
    expect(
      parseFfprobeVideoDimensions(JSON.stringify({ streams: [{ width: 0, height: 1280 }] })),
    ).toBeUndefined();
    expect(
      parseFfprobeVideoDimensions(JSON.stringify({ streams: [{ width: 720.5, height: 1280 }] })),
    ).toBeUndefined();
  });
});

describe("probeVideoDimensions", () => {
  it("probes video dimensions through ffprobe stdin", async () => {
    const buffer = Buffer.from("video");
    runFfprobe.mockResolvedValueOnce(JSON.stringify({ streams: [{ width: 720, height: 1280 }] }));

    await expect(probeVideoDimensions(buffer)).resolves.toEqual({ width: 720, height: 1280 });

    expect(runFfprobe).toHaveBeenCalledWith(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        "pipe:0",
      ],
      { input: buffer },
    );
  });

  it("falls back when ffprobe fails or returns malformed output", async () => {
    runFfprobe.mockRejectedValueOnce(new Error("missing ffprobe"));
    await expect(probeVideoDimensions(Buffer.from("video"))).resolves.toBeUndefined();

    runFfprobe.mockResolvedValueOnce("{");
    await expect(probeVideoDimensions(Buffer.from("video"))).resolves.toBeUndefined();
  });
});
