// Audio transcode helpers run ffmpeg to convert audio for provider requirements.
import path from "node:path";
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { tempWorkspaceSync, withTempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
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
  const baseName = basenameFromAnyPath(value?.trim() || DEFAULT_OUTPUT_FILE_NAME);
  if (/^[a-zA-Z0-9._-]{1,80}$/.test(baseName) && baseName !== "." && baseName !== "..") {
    return baseName;
  }
  return DEFAULT_OUTPUT_FILE_NAME;
}

function resolveMaxDurationSeconds(value?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("maxDurationSeconds must be a positive finite number");
  }
  return value;
}

/** Transcodes arbitrary audio input into mono Opus using a scoped temp workspace. */
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
  /** Maximum output duration passed to ffmpeg's `-t` option. */
  maxDurationSeconds?: number;
}): Promise<Buffer> {
  const maxDurationSeconds = resolveMaxDurationSeconds(params.maxDurationSeconds);
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
              ...(maxDurationSeconds === undefined ? [] : ["-t", String(maxDurationSeconds)]),
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

/** Outcome for lightweight container transcodes that may be unsupported or intentionally skipped. */
type AudioContainerTranscodeOutcome =
  | { ok: true; buffer: Buffer }
  | {
      ok: false;
      reason:
        | "platform-unsupported"
        | "invalid-extension"
        | "noop-same-container"
        | "no-recipe"
        | "transcoder-failed";
      detail?: string;
    };

/** Transcodes known audio container pairs, currently using macOS afconvert recipes where needed. */
export async function transcodeAudioBuffer(params: {
  audioBuffer: Buffer;
  sourceExtension: string;
  targetExtension: string;
  timeoutMs?: number;
}): Promise<AudioContainerTranscodeOutcome> {
  const source = normalizeContainerExt(params.sourceExtension);
  const target = normalizeContainerExt(params.targetExtension);
  if (!source || !target) {
    return { ok: false, reason: "invalid-extension" };
  }
  if (source === target) {
    return { ok: false, reason: "noop-same-container" };
  }
  const recipe = pickAfconvertRecipe(source, target);
  if (!recipe) {
    return { ok: false, reason: "no-recipe" };
  }
  if (process.platform !== "darwin") {
    return { ok: false, reason: "platform-unsupported" };
  }

  // afconvert is macOS-only and writes native Messages-compatible voice containers.
  const tmp = tempWorkspaceSync({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "tts-transcode-",
  });
  const inPath = tmp.write(`in.${source}`, params.audioBuffer);
  const outPath = tmp.path(`out.${target}`);
  try {
    const result = await runAfconvert({
      args: [...recipe, inPath, outPath],
      timeoutMs: params.timeoutMs ?? 5000,
    });
    if (!result.ok) {
      return { ok: false, reason: "transcoder-failed", detail: result.detail };
    }
    return { ok: true, buffer: tmp.read(`out.${target}`) };
  } catch (err) {
    return { ok: false, reason: "transcoder-failed", detail: (err as Error).message };
  } finally {
    tmp.cleanup();
  }
}

function normalizeContainerExt(ext: string): string | undefined {
  const trimmed = ext.trim().toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]{1,12}$/.test(trimmed) ? trimmed : undefined;
}

function pickAfconvertRecipe(_source: string, target: string): string[] | undefined {
  if (target === "caf") {
    // Opus-in-CAF matches native Messages voice memo attachments.
    return ["-f", "caff", "-d", "opus@24000", "-c", "1"];
  }
  return undefined;
}

async function runAfconvert(params: {
  args: string[];
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const result = await runCommandWithTimeout(["/usr/bin/afconvert", ...params.args], {
      maxOutputBytes: 1024,
      timeoutMs: params.timeoutMs,
    });
    if (result.termination === "timeout") {
      return { ok: false, detail: `timeout-${params.timeoutMs}ms` };
    }
    return result.code === 0
      ? { ok: true }
      : { ok: false, detail: `exit-${result.code ?? "unknown"}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
