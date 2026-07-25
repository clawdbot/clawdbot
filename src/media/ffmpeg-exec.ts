// FFmpeg exec helpers run ffmpeg and ffprobe with normalized errors.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { runExec, type RunExecOptions } from "../process/exec.js";
import {
  MEDIA_FFMPEG_MAX_BUFFER_BYTES,
  MEDIA_FFMPEG_TIMEOUT_MS,
  MEDIA_FFPROBE_TIMEOUT_MS,
} from "./ffmpeg-limits.js";

/** Process limits and optional stdin payload for ffmpeg/ffprobe helper calls. */
type MediaExecOptions = {
  timeoutMs?: number;
  maxBufferBytes?: number;
  input?: Buffer | string;
};

function resolveExecOptions(
  defaultTimeoutMs: number,
  options: MediaExecOptions | undefined,
): RunExecOptions {
  return {
    input: options?.input,
    logOutput: false,
    maxBuffer: options?.maxBufferBytes ?? MEDIA_FFMPEG_MAX_BUFFER_BYTES,
    timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
  };
}

function requireSystemBin(name: string): string {
  const resolved = resolveSystemBin(name, { trust: "standard" });
  if (!resolved) {
    const hint =
      process.platform === "darwin"
        ? "e.g. brew install ffmpeg"
        : "e.g. apt install ffmpeg / dnf install ffmpeg";
    throw new Error(
      `${name} not found in trusted system directories. ` +
        `Install it via your system package manager (${hint}).`,
    );
  }
  return resolved;
}

/** Resolves ffmpeg from trusted system paths before command execution. */
export function resolveFfmpegBin(): string {
  return requireSystemBin("ffmpeg");
}

/** Runs ffprobe with optional stdin input. */
export async function runFfprobe(args: string[], options?: MediaExecOptions): Promise<string> {
  const { stdout } = await runExec(
    requireSystemBin("ffprobe"),
    args,
    resolveExecOptions(MEDIA_FFPROBE_TIMEOUT_MS, options),
  );
  return stdout;
}

/** Runs ffmpeg with bounded timeout and buffer settings. */
export async function runFfmpeg(args: string[], options?: MediaExecOptions): Promise<string> {
  const { stdout } = await runExec(
    resolveFfmpegBin(),
    args,
    resolveExecOptions(MEDIA_FFMPEG_TIMEOUT_MS, options),
  );
  return stdout;
}

/** Splits ffprobe CSV-ish output into normalized lowercase fields. */
function parseFfprobeCsvFields(stdout: string, maxFields: number): string[] {
  return stdout
    .trim()
    .split(/[,\r\n]+/, maxFields)
    .map((field) => normalizeLowercaseStringOrEmpty(field));
}

function parseFfprobeSampleRateHz(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const sampleRate = Number(value);
  return Number.isSafeInteger(sampleRate) && sampleRate > 0 ? sampleRate : null;
}

/** Parses codec and positive sample rate from compact ffprobe stream output. */
export function parseFfprobeCodecAndSampleRate(stdout: string): {
  codec: string | null;
  sampleRateHz: number | null;
} {
  const [codecRaw, sampleRateRaw] = parseFfprobeCsvFields(stdout, 2);
  const codec = codecRaw ? codecRaw : null;
  return {
    codec,
    sampleRateHz: parseFfprobeSampleRateHz(sampleRateRaw),
  };
}
