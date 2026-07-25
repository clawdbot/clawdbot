// Video dimension helpers read video dimensions through ffprobe.
import { runFfprobe } from "./ffmpeg-exec.js";

/** Positive video dimensions reported by ffprobe for the first video stream. */
type VideoDimensions = {
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
function parseFfprobeVideoDimensions(stdout: string): VideoDimensions | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const streams = (parsed as { streams?: unknown }).streams;
  const stream = Array.isArray(streams) ? streams[0] : undefined;
  if (!stream || typeof stream !== "object") {
    return undefined;
  }
  const record = stream as Record<string, unknown>;
  const width = parsePositiveDimension(record.width);
  const height = parsePositiveDimension(record.height);
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
