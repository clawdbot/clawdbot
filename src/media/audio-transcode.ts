import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runFfmpeg } from "./ffmpeg-exec.js";

const DEFAULT_OPUS_SAMPLE_RATE_HZ = 48_000;
const DEFAULT_OPUS_BITRATE = "64k";
const DEFAULT_OPUS_CHANNELS = 1;
const DEFAULT_TEMP_PREFIX = "audio-opus-";
const DEFAULT_OUTPUT_FILE_NAME = "voice.opus";

function normalizeAudioExtension(params: {
  inputExtension?: string;
  inputFileName?: string;
}): string {
  const fromExtension = params.inputExtension?.trim();
  const candidate = fromExtension
    ? fromExtension.startsWith(".")
      ? fromExtension
      : `.${fromExtension}`
    : path.extname(params.inputFileName ?? "");
  const normalized = candidate.toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(normalized) ? normalized : ".audio";
}

function normalizeTempPrefix(value?: string): string {
  const sanitized = value?.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return DEFAULT_TEMP_PREFIX;
  }
  return sanitized.endsWith("-") ? sanitized : `${sanitized}-`;
}

function normalizeOutputFileName(value?: string): string {
  const baseName = path.basename(value?.trim() || DEFAULT_OUTPUT_FILE_NAME);
  if (/^[a-zA-Z0-9._-]{1,80}$/.test(baseName) && baseName !== "." && baseName !== "..") {
    return baseName;
  }
  return DEFAULT_OUTPUT_FILE_NAME;
}

export async function transcodeAudioBufferToOpus(params: {
  audioBuffer: Buffer;
  inputExtension?: string;
  inputFileName?: string;
  tempPrefix?: string;
  outputFileName?: string;
  timeoutMs?: number;
  sampleRateHz?: number;
  bitrate?: string;
  channels?: number;
}): Promise<Buffer> {
  const tempRoot = resolvePreferredOpenClawTmpDir();
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(path.join(tempRoot, normalizeTempPrefix(params.tempPrefix)));
  try {
    const inputPath = path.join(tempDir, `input${normalizeAudioExtension(params)}`);
    const outputPath = path.join(tempDir, normalizeOutputFileName(params.outputFileName));
    await writeFile(inputPath, params.audioBuffer, { mode: 0o600 });
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "libopus",
        "-b:a",
        params.bitrate ?? DEFAULT_OPUS_BITRATE,
        "-ar",
        String(params.sampleRateHz ?? DEFAULT_OPUS_SAMPLE_RATE_HZ),
        "-ac",
        String(params.channels ?? DEFAULT_OPUS_CHANNELS),
        outputPath,
      ],
      { timeoutMs: params.timeoutMs },
    );
    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
