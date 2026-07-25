// Tts Local Cli provider module implements model/runtime integration.
import { readdirSync } from "node:fs";
import path from "node:path";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  readRegularFileSync,
  writeExternalFileWithinRoot,
} from "openclaw/plugin-sdk/security-runtime";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const log = createSubsystemLogger("tts-local-cli");

const VALID_OUTPUT_FORMATS = ["mp3", "opus", "wav"] as const;
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".opus", ".ogg", ".m4a"]);
type OutputFormat = (typeof VALID_OUTPUT_FORMATS)[number];

type CliConfig = {
  command: string;
  args?: string[];
  outputFormat?: OutputFormat;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_AUDIO_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_CLI_STDERR_BYTES = 1024 * 1024;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
}

function asRecord(value: unknown): Record<string, string> | undefined {
  const obj = asObject(value);
  if (!obj) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeOutputFormat(value: unknown): OutputFormat {
  if (typeof value !== "string") {
    return "mp3";
  }
  const lower = value.toLowerCase().trim();
  if (VALID_OUTPUT_FORMATS.includes(lower as OutputFormat)) {
    return lower as OutputFormat;
  }
  return "mp3";
}

function resolveCliProviderConfig(rawConfig: Record<string, unknown>): SpeechProviderConfig {
  const providers = asObject(rawConfig.providers);
  return asObject(providers?.["tts-local-cli"]) ?? asObject(providers?.cli) ?? {};
}

function getConfig(cfg: SpeechProviderConfig): CliConfig | null {
  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  if (!command) {
    return null;
  }
  return {
    command,
    args: asStringArray(cfg.args),
    outputFormat: normalizeOutputFormat(cfg.outputFormat),
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
    env: asRecord(cfg.env),
  };
}

function stripEmojis(text: string): string {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyTemplate(str: string, ctx: Record<string, string | undefined>): string {
  return str.replace(/{{\s*(\w+)\s*}}/gi, (_, key) => {
    const normalizedKey = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
    return ctx[normalizedKey] ?? ctx[key] ?? "";
  });
}

function parseCommand(cmdStr: string): { cmd: string; initialArgs: string[] } {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const char of cmdStr.trim()) {
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = true;
      quoteChar = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    parts.push(current);
  }
  return { cmd: parts[0] || "", initialArgs: parts.slice(1) };
}

function findAudioFile(dir: string, baseName: string): string | null {
  const files = readdirSync(dir);
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext) && (file.startsWith(baseName) || file.includes(baseName))) {
      return path.join(dir, file);
    }
  }
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) {
      return path.join(dir, file);
    }
  }
  return null;
}

function detectFormat(filePath: string): "mp3" | "opus" | "wav" | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".opus" || ext === ".ogg") {
    return "opus";
  }
  if (ext === ".wav") {
    return "wav";
  }
  if (ext === ".mp3" || ext === ".m4a") {
    return "mp3";
  }
  return null;
}

function getFileExt(format: string): string {
  if (format === "opus") {
    return ".opus";
  }
  if (format === "wav") {
    return ".wav";
  }
  return ".mp3";
}

function readAudioFile(filePath: string): Buffer {
  return readRegularFileSync({ filePath, maxBytes: MAX_AUDIO_OUTPUT_BYTES }).buffer;
}

async function runCli(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  text: string;
  outputDir: string;
  filePrefix: string;
  outputFormat?: OutputFormat;
}): Promise<{ buffer: Buffer; actualFormat: "mp3" | "opus" | "wav"; audioPath?: string }> {
  const cleanText = stripEmojis(params.text);
  if (!cleanText) {
    throw new Error("CLI TTS: text is empty after removing emojis");
  }

  const outputExt = getFileExt(params.outputFormat ?? "wav");
  const ctx: Record<string, string | undefined> = {
    Text: cleanText,
    OutputPath: path.join(params.outputDir, `${params.filePrefix}${outputExt}`),
    OutputDir: params.outputDir,
    OutputBase: params.filePrefix,
  };

  const { cmd, initialArgs } = parseCommand(params.command);
  if (!cmd) {
    throw new Error("CLI TTS: invalid command");
  }

  const baseArgs = [...initialArgs, ...params.args];
  const args = baseArgs.map((a) => applyTemplate(a, ctx));
  const input = baseArgs.some((a) => /{{\s*text\s*}}/i.test(a)) ? "" : cleanText;
  const result = await runCommandBuffered([cmd, ...args], {
    cwd: params.cwd,
    env: params.env,
    input,
    maxOutputBytes: {
      stdout: MAX_AUDIO_OUTPUT_BYTES,
      stderr: MAX_CLI_STDERR_BYTES,
    },
    timeoutMs: params.timeoutMs,
  });
  if (result.termination === "timeout") {
    throw new Error(`CLI TTS timed out after ${params.timeoutMs}ms`);
  }
  if (result.termination === "output-limit") {
    const stream = result.outputLimitStream ?? "stdout";
    const maxBytes = stream === "stderr" ? MAX_CLI_STDERR_BYTES : MAX_AUDIO_OUTPUT_BYTES;
    throw new Error(`CLI TTS ${stream} exceeded ${maxBytes} bytes`);
  }
  if (result.code !== null && result.code !== 0) {
    throw new Error(`CLI TTS exit ${result.code}: ${result.stderr.toString("utf8")}`);
  }
  if (result.termination !== "exit" && result.termination !== "error") {
    throw new Error(`CLI TTS failed: ${result.error?.message ?? result.termination}`);
  }
  if (result.termination === "error" && result.code !== 0) {
    throw new Error(`CLI TTS failed: ${result.error?.message ?? result.termination}`);
  }

  const audioFile = findAudioFile(params.outputDir, params.filePrefix);
  if (audioFile) {
    const format = detectFormat(audioFile);
    if (!format) {
      throw new Error(`CLI TTS: unknown format for ${audioFile}`);
    }
    return {
      buffer: readAudioFile(audioFile),
      actualFormat: format,
      audioPath: audioFile,
    };
  }
  if (result.termination === "error" && result.errorStream !== "stderr") {
    throw new Error(`CLI TTS failed: ${result.error?.message ?? result.termination}`);
  }

  const stdout = result.stdout;
  if (stdout.length > 0) {
    // Assume WAV for stdout output; could be MP3 but caller should convert if needed
    return { buffer: stdout, actualFormat: "wav" };
  }
  if (result.termination === "error") {
    throw new Error(`CLI TTS failed: ${result.error?.message ?? result.termination}`);
  }
  throw new Error("CLI TTS produced no output");
}

async function runFfmpegToBuffer(params: {
  args: string[];
  outputDir: string;
  outputFileName: string;
}): Promise<Buffer> {
  const outputPath = path.join(params.outputDir, params.outputFileName);
  await writeExternalFileWithinRoot({
    rootDir: params.outputDir,
    path: params.outputFileName,
    write: async (tempPath) => {
      await runFfmpeg([...params.args, tempPath]);
    },
  });
  return readAudioFile(outputPath);
}

async function convertAudio(
  inputPath: string,
  outputDir: string,
  target: OutputFormat,
): Promise<Buffer> {
  const outputFileName = `converted${getFileExt(target)}`;
  const args = ["-y", "-i", inputPath];
  if (target === "opus") {
    args.push("-c:a", "libopus", "-b:a", "64k", "-f", "opus");
  } else if (target === "wav") {
    args.push("-c:a", "pcm_s16le", "-f", "wav");
  } else {
    args.push("-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3");
  }
  return await runFfmpegToBuffer({ args, outputDir, outputFileName });
}

async function convertToRawPcm(inputPath: string, outputDir: string): Promise<Buffer> {
  // Output raw 16kHz mono 16-bit little-endian PCM (no WAV headers)
  const outputFileName = "telephony.pcm";
  const args = [
    "-y",
    "-i",
    inputPath,
    "-c:a",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-f",
    "s16le",
  ];
  return await runFfmpegToBuffer({ args, outputDir, outputFileName });
}

export function buildCliSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "tts-local-cli",
    aliases: ["cli"],
    label: "Local CLI",
    autoSelectOrder: 1000,

    resolveConfig(ctx): SpeechProviderConfig {
      return resolveCliProviderConfig(ctx.rawConfig);
    },

    isConfigured(ctx): boolean {
      return getConfig(ctx.providerConfig) !== null;
    },

    async synthesize(req: SpeechSynthesisRequest) {
      const config = getConfig(req.providerConfig);
      if (!config) {
        throw new Error("CLI TTS not configured");
      }

      log.debug(`synthesize: text=${truncateUtf16Safe(req.text, 50)}...`);

      const temp = await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-cli-tts-",
      });
      const tempDir = temp.dir;

      try {
        const result = await runCli({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          env: config.env,
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          text: req.text,
          outputDir: tempDir,
          filePrefix: "speech",
          outputFormat: config.outputFormat,
        });

        log.debug(`synthesize: format=${result.actualFormat}, size=${result.buffer.length}`);

        let buffer: Buffer;
        let format: OutputFormat;

        if (req.target === "voice-note") {
          if (result.actualFormat !== "opus") {
            const inputFile =
              result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
            if (!result.audioPath) {
              await temp.write(`input${getFileExt(result.actualFormat)}`, result.buffer);
            }
            buffer = await convertAudio(inputFile, tempDir, "opus");
            format = "opus";
          } else {
            buffer = result.buffer;
            format = "opus";
          }
        } else {
          const desired = config.outputFormat ?? "mp3";
          if (result.actualFormat !== desired) {
            const inputFile =
              result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
            if (!result.audioPath) {
              await temp.write(`input${getFileExt(result.actualFormat)}`, result.buffer);
            }
            buffer = await convertAudio(inputFile, tempDir, desired);
            format = desired;
          } else {
            buffer = result.buffer;
            format = result.actualFormat;
          }
        }

        const fileExtension = format === "opus" ? ".ogg" : `.${format}`;
        return {
          audioBuffer: buffer,
          outputFormat: format,
          fileExtension,
          voiceCompatible: req.target === "voice-note" && format === "opus",
        };
      } finally {
        await temp.cleanup();
      }
    },

    async synthesizeTelephony(req: SpeechTelephonySynthesisRequest) {
      const config = getConfig(req.providerConfig);
      if (!config) {
        throw new Error("CLI TTS not configured");
      }

      log.debug(`synthesizeTelephony: text=${truncateUtf16Safe(req.text, 50)}...`);

      const temp = await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-cli-tts-",
      });
      const tempDir = temp.dir;

      try {
        const result = await runCli({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          env: config.env,
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          text: req.text,
          outputDir: tempDir,
          filePrefix: "telephony",
          outputFormat: config.outputFormat,
        });

        const inputFile =
          result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
        if (!result.audioPath) {
          await temp.write(`input${getFileExt(result.actualFormat)}`, result.buffer);
        }

        // Convert to raw 16kHz mono PCM for telephony (no WAV headers)
        const pcmBuffer = await convertToRawPcm(inputFile, tempDir);

        return {
          audioBuffer: pcmBuffer,
          outputFormat: "pcm",
          sampleRate: 16000,
        };
      } finally {
        await temp.cleanup();
      }
    },
  };
}
