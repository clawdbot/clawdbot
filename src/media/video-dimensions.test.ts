// Video dimension tests cover ffprobe parsing and fallback behavior.
import { describe, expect, it, vi } from "vitest";
import { probeVideoDimensions } from "./video-dimensions.js";

const { runFfprobe } = vi.hoisted(() => ({
  runFfprobe: vi.fn(),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfprobe,
}));

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
