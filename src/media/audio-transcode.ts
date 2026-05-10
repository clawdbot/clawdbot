import path from "node:path";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
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
  return await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: normalizeTempPrefix(params.tempPrefix),
    },
    async (workspace) => {
      const inputPath = await workspace.write(
        `input${normalizeAudioExtension(params)}`,
        params.audioBuffer,
      );
      const outputFileName = normalizeOutputFileName(params.outputFileName);
      await writeExternalFileWithinRoot({
        rootDir: workspace.dir,
        path: outputFileName,
        write: async (outputPath) => {
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
              "-f",
              "opus",
              outputPath,
            ],
            { timeoutMs: params.timeoutMs },
          );
        },
      });
      return await workspace.read(outputFileName);
    },
  );
}
