// Video dimension helpers read video dimensions through ffprobe.
import { runFfprobe } from "./ffmpeg-exec.js";

/** Positive video dimensions reported by ffprobe for the first video stream. */
export type VideoDimensions = {
  width: number;
  height: number;
};

function parsePositiveDimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/** Parses ffprobe JSON output, accepting only positive integer first-stream dimensions. */
export function parseFfprobeVideoDimensions(stdout: string): VideoDimensions | undefined {
  const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: unknown; height?: unknown }> };
  const stream = parsed.streams?.[0];
  const width = parsePositiveDimension(stream?.width);
  const height = parsePositiveDimension(stream?.height);
  return width && height ? { width, height } : undefined;
}

/** Probes a video buffer through ffprobe stdin and treats probe failures as unknown dimensions. */
export async function probeVideoDimensions(buffer: Buffer): Promise<VideoDimensions | undefined> {
  try {
    const stdout = await runFfprobe(
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
    return parseFfprobeVideoDimensions(stdout);
  } catch {
    return undefined;
  }
}
