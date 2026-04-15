import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { asRecord, readString } from "../config-record-shared.js";
import { debugLog, debugError, debugWarn } from "./debug-log.js";
import { detectFfmpeg, isWindows } from "./platform.js";

type SilkWasm = typeof import("silk-wasm");
let _silkWasmPromise: Promise<SilkWasm | null> | null = null;

function loadSilkWasm(): Promise<SilkWasm | null> {
  if (_silkWasmPromise) {
    return _silkWasmPromise;
  }
  _silkWasmPromise = import("silk-wasm").catch((err) => {
    debugWarn(
      `[audio-convert] silk-wasm not available; SILK encode/decode disabled (${formatErrorMessage(err)})`,
    );
    return null;
  });
  return _silkWasmPromise;
}

/** Wrap PCM s16le bytes in a WAV container. */
function pcmToWav(
  pcmData: Uint8Array,
  sampleRate: number,
  channels: number = 1,
  bitsPerSample: number = 16,
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);

  // fmt sub-chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // sub-chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

/** Strip a leading AMR header from QQ voice payloads when present. */
function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from("#!AMR\n");
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

/** Convert SILK or AMR voice files into WAV. */
export async function convertSilkToWav(
  inputPath: string,
  outputDir?: string,
): Promise<{ wavPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const fileBuf = fs.readFileSync(inputPath);

  const strippedBuf = stripAmrHeader(fileBuf);

  const rawData = new Uint8Array(
    strippedBuf.buffer,
    strippedBuf.byteOffset,
    strippedBuf.byteLength,
  );

  const silk = await loadSilkWasm();
  if (!silk || !silk.isSilk(rawData)) {
    return null;
  }

  // QQ voice commonly uses 24 kHz.
  const sampleRate = 24000;
  const result = await silk.decode(rawData, sampleRate);

  const wavBuffer = pcmToWav(result.data, sampleRate);

  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${baseName}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);

  return { wavPath, duration: result.duration };
}

/** Return true when an attachment looks like a voice file. */
export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === "voice" || att.content_type?.startsWith("audio/")) {
    return true;
  }
  const ext = att.filename ? normalizeLowercaseStringOrEmpty(path.extname(att.filename)) : "";
  return [".amr", ".silk", ".slk", ".slac"].includes(ext);
}

/** Format a duration as a user-readable string. */
export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}m ${remainSeconds}s` : `${minutes}m`;
}

export function isAudioFile(filePath: string, mimeType?: string): boolean {
  // Prefer MIME when extension data is missing or misleading.
  if (mimeType) {
    if (mimeType === "voice" || mimeType.startsWith("audio/")) {
      return true;
    }
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  return [
    ".silk",
    ".slk",
    ".amr",
    ".wav",
    ".mp3",
    ".ogg",
    ".opus",
    ".aac",
    ".flac",
    ".m4a",
    ".wma",
    ".pcm",
  ].includes(ext);
}

/** Voice MIME types the QQ platform accepts without transcoding. */
const QQ_NATIVE_VOICE_MIMES = new Set([
  "audio/silk",
  "audio/amr",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
]);

/** Voice extensions the QQ platform accepts without transcoding. */
const QQ_NATIVE_VOICE_EXTS = new Set([".silk", ".slk", ".amr", ".wav", ".mp3"]);

/**
 * Return true when voice input must be transcoded before upload.
 */
export function shouldTranscodeVoice(filePath: string, mimeType?: string): boolean {
  // Prefer MIME when it is available.
  if (mimeType && QQ_NATIVE_VOICE_MIMES.has(normalizeLowercaseStringOrEmpty(mimeType))) {
    return false;
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  if (QQ_NATIVE_VOICE_EXTS.has(ext)) {
    return false;
  }
  return isAudioFile(filePath, mimeType);
}

// TTS helpers.

export interface TTSConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  authStyle?: "bearer" | "api-key";
  queryParams?: Record<string, string>;
  speed?: number;
}

type QQBotTtsProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  authStyle?: string;
  queryParams?: Record<string, string>;
};

type QQBotTtsBlock = QQBotTtsProviderConfig & {
  model?: string;
  voice?: string;
  speed?: number;
};

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function readStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, entryValue]) =>
      typeof entryValue === "string" ? [[key, entryValue]] : [],
    ),
  );
}

function resolveTTSFromBlock(
  block: QQBotTtsBlock,
  providerCfg: QQBotTtsProviderConfig | undefined,
): TTSConfig | null {
  const baseUrl = readString(block, "baseUrl") ?? readString(providerCfg, "baseUrl");
  const apiKey = readString(block, "apiKey") ?? readString(providerCfg, "apiKey");
  const model = readString(block, "model") ?? "tts-1";
  const voice = readString(block, "voice") ?? "alloy";
  if (!baseUrl || !apiKey) {
    return null;
  }

  const authStyle =
    (readString(block, "authStyle") ?? readString(providerCfg, "authStyle")) === "api-key"
      ? ("api-key" as const)
      : ("bearer" as const);
  const queryParams: Record<string, string> = {
    ...readStringMap(providerCfg?.queryParams),
    ...readStringMap(block.queryParams),
  };
  const speed = readNumber(block, "speed");

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    voice,
    authStyle,
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
}

export function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null {
  const models = asRecord(cfg.models);
  const providers = asRecord(models?.providers);

  // Prefer plugin-specific TTS config first.
  const channels = asRecord(cfg.channels);
  const qqbot = asRecord(channels?.qqbot);
  const channelTts = asRecord(qqbot?.tts);
  if (channelTts && channelTts.enabled !== false) {
    const providerId = readString(channelTts, "provider") ?? "openai";
    const providerCfg = asRecord(providers?.[providerId]);
    const result = resolveTTSFromBlock(channelTts, providerCfg);
    if (result) {
      return result;
    }
  }

  // Fall back to framework-level TTS config.
  const messages = asRecord(cfg.messages);
  const msgTts = asRecord(messages?.tts);
  const autoMode = readString(msgTts, "auto");
  if (msgTts && autoMode !== "off" && autoMode !== "disabled") {
    const providerId = readString(msgTts, "provider") ?? "openai";
    const providerBlock = asRecord(msgTts[providerId]) ?? {};
    const providerCfg = asRecord(providers?.[providerId]);
    const result = resolveTTSFromBlock(providerBlock, providerCfg);
    if (result) {
      return result;
    }
  }

  return null;
}

/**
 * Check whether global TTS is potentially available by inspecting the
 * framework-level `messages.tts` config.  This mirrors the resolution logic
 * in the core `resolveTtsConfig`: when `auto` is set it must not be `"off"`;
 * when only the legacy `enabled` boolean is present it must be truthy;
 * when neither is set TTS defaults to off.
 *
 * This does NOT guarantee a specific provider is registered/configured – it
 * only checks that TTS is not explicitly (or implicitly) disabled.
 */
export function isGlobalTTSAvailable(cfg: OpenClawConfig): boolean {
  const msgTts = cfg.messages?.tts;
  if (!msgTts) {
    return false;
  }
  // Framework canonical field takes precedence.
  if (msgTts.auto) {
    return msgTts.auto !== "off";
  }
  // Legacy compat: `enabled: true` → "always", absent/false → "off".
  return msgTts.enabled === true;
}

/** Build the TTS endpoint URL and auth headers. */
function buildTTSRequest(ttsCfg: TTSConfig): { url: string; headers: Record<string, string> } {
  let url = `${ttsCfg.baseUrl}/audio/speech`;
  if (ttsCfg.queryParams && Object.keys(ttsCfg.queryParams).length > 0) {
    const qs = new URLSearchParams(ttsCfg.queryParams).toString();
    url += `?${qs}`;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ttsCfg.authStyle === "api-key") {
    headers["api-key"] = ttsCfg.apiKey;
  } else {
    headers["Authorization"] = `Bearer ${ttsCfg.apiKey}`;
  }

  return { url, headers };
}

export async function textToSpeechPCM(
  text: string,
  ttsCfg: TTSConfig,
): Promise<{ pcmBuffer: Buffer; sampleRate: number }> {
  const sampleRate = 24000;
  const { url, headers } = buildTTSRequest(ttsCfg);

  debugLog(
    `[tts] Request: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, url=${url}`,
  );
  debugLog(
    `[tts] Input text (${text.length} chars): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
  );

  // Prefer PCM first to avoid an extra decode pass.
  const formats: Array<{ format: string; needsDecode: boolean }> = [
    { format: "pcm", needsDecode: false },
    { format: "mp3", needsDecode: true },
  ];

  let lastError: Error | null = null;
  const startTime = Date.now();

  for (const { format, needsDecode } of formats) {
    const controller = new AbortController();
    const ttsTimeout = setTimeout(() => controller.abort(), 120000);

    try {
      const body: Record<string, unknown> = {
        model: ttsCfg.model,
        input: text,
        voice: ttsCfg.voice,
        response_format: format,
        ...(format === "pcm" ? { sample_rate: sampleRate } : {}),
        ...(ttsCfg.speed !== undefined ? { speed: ttsCfg.speed } : {}),
      };

      debugLog(`[tts] Trying format=${format}...`);
      const fetchStart = Date.now();
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(ttsTimeout));

      const fetchMs = Date.now() - fetchStart;

      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        debugLog(
          `[tts] HTTP ${resp.status} for format=${format} (${fetchMs}ms): ${detail.slice(0, 200)}`,
        );
        // Some providers reject PCM but accept MP3, so retry there.
        if (format === "pcm" && (resp.status === 400 || resp.status === 422)) {
          debugLog(`[tts] PCM format not supported, falling back to mp3`);
          lastError = new Error(`TTS PCM not supported: ${detail.slice(0, 200)}`);
          continue;
        }
        throw new Error(`TTS failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      const rawBuffer = Buffer.from(arrayBuffer);
      debugLog(
        `[tts] Response OK: format=${format}, size=${rawBuffer.length} bytes, latency=${fetchMs}ms`,
      );

      if (!needsDecode) {
        debugLog(
          `[tts] Done: PCM direct, ${rawBuffer.length} bytes, total=${Date.now() - startTime}ms`,
        );
        return { pcmBuffer: rawBuffer, sampleRate };
      }

      // MP3 responses must be decoded back into PCM.
      debugLog(`[tts] Decoding mp3 response (${rawBuffer.length} bytes) to PCM...`);
      const tmpDir = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "tts-")));
      const tmpMp3 = path.join(tmpDir, "tts.mp3");
      fs.writeFileSync(tmpMp3, rawBuffer);

      try {
        // Prefer ffmpeg when it is available.
        const ffmpegCmd = await checkFfmpeg();
        if (ffmpegCmd) {
          const pcmBuf = await ffmpegToPCM(ffmpegCmd, tmpMp3, sampleRate);
          debugLog(
            `[tts] Done: mp3→PCM (ffmpeg), ${pcmBuf.length} bytes, total=${Date.now() - startTime}ms`,
          );
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        const pcmBuf = await wasmDecodeMp3ToPCM(rawBuffer, sampleRate);
        if (pcmBuf) {
          debugLog(
            `[tts] Done: mp3→PCM (wasm), ${pcmBuf.length} bytes, total=${Date.now() - startTime}ms`,
          );
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        throw new Error("No decoder available for mp3 (install ffmpeg for best compatibility)");
      } finally {
        try {
          fs.unlinkSync(tmpMp3);
          fs.rmdirSync(tmpDir);
        } catch {}
      }
    } catch (err) {
      clearTimeout(ttsTimeout);
      lastError = err instanceof Error ? err : new Error(String(err));
      debugLog(`[tts] Error for format=${format}: ${lastError.message.slice(0, 200)}`);
      if (format === "pcm") {
        continue;
      }
      throw lastError;
    }
  }

  debugLog(`[tts] All formats exhausted after ${Date.now() - startTime}ms`);
  throw lastError ?? new Error("TTS failed: all formats exhausted");
}

export async function pcmToSilk(
  pcmBuffer: Buffer,
  sampleRate: number,
): Promise<{ silkBuffer: Buffer; duration: number }> {
  const silk = await loadSilkWasm();
  if (!silk) {
    throw new Error("silk-wasm is not available; cannot encode PCM to SILK");
  }
  const pcmData = new Uint8Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
  const result = await silk.encode(pcmData, sampleRate);
  return {
    silkBuffer: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength),
    duration: result.duration,
  };
}

export async function textToSilk(
  text: string,
  ttsCfg: TTSConfig,
  outputDir: string,
): Promise<{ silkPath: string; silkBase64: string; duration: number }> {
  const { pcmBuffer, sampleRate } = await textToSpeechPCM(text, ttsCfg);
  const { silkBuffer, duration } = await pcmToSilk(pcmBuffer, sampleRate);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const silkPath = path.join(outputDir, `tts-${Date.now()}.silk`);
  fs.writeFileSync(silkPath, silkBuffer);

  return { silkPath, silkBase64: silkBuffer.toString("base64"), duration };
}

// Generic audio -> SILK conversion.

/** Upload formats accepted directly by the QQ Bot API. */
const QQ_NATIVE_UPLOAD_FORMATS = [".wav", ".mp3", ".silk"];

/**
 * Convert a local audio file into an uploadable Base64 payload.
 */
export async function audioFileToSilkBase64(
  filePath: string,
  directUploadFormats?: string[],
): Promise<string | null> {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) {
    debugError(`[audio-convert] file is empty: ${filePath}`);
    return null;
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));

  const uploadFormats = directUploadFormats
    ? normalizeFormats(directUploadFormats)
    : QQ_NATIVE_UPLOAD_FORMATS;
  if (uploadFormats.includes(ext)) {
    debugLog(`[audio-convert] direct upload (QQ native format): ${ext} (${buf.length} bytes)`);
    return buf.toString("base64");
  }

  // Some .slk/.slac files are already SILK and can be uploaded directly.
  if ([".slk", ".slac"].includes(ext)) {
    const stripped = stripAmrHeader(buf);
    const raw = new Uint8Array(stripped.buffer, stripped.byteOffset, stripped.byteLength);
    const silk = await loadSilkWasm();
    if (silk?.isSilk(raw)) {
      debugLog(`[audio-convert] SILK file, direct use: ${filePath} (${buf.length} bytes)`);
      return buf.toString("base64");
    }
  }

  // Also detect SILK by header, not just by extension.
  const rawCheck = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const strippedCheck = stripAmrHeader(buf);
  const strippedRaw = new Uint8Array(
    strippedCheck.buffer,
    strippedCheck.byteOffset,
    strippedCheck.byteLength,
  );
  const silkForCheck = await loadSilkWasm();
  if (silkForCheck?.isSilk(rawCheck) || silkForCheck?.isSilk(strippedRaw)) {
    debugLog(`[audio-convert] SILK detected by header: ${filePath} (${buf.length} bytes)`);
    return buf.toString("base64");
  }

  const targetRate = 24000;

  // Prefer ffmpeg for broad codec coverage.
  const ffmpegCmd = await checkFfmpeg();
  if (ffmpegCmd) {
    try {
      debugLog(
        `[audio-convert] ffmpeg (${ffmpegCmd}): converting ${ext} (${buf.length} bytes) → PCM s16le ${targetRate}Hz`,
      );
      const pcmBuf = await ffmpegToPCM(ffmpegCmd, filePath, targetRate);
      if (pcmBuf.length === 0) {
        debugError(`[audio-convert] ffmpeg produced empty PCM output`);
        return null;
      }
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      debugLog(`[audio-convert] ffmpeg: ${ext} → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString("base64");
    } catch (err) {
      debugError(`[audio-convert] ffmpeg conversion failed: ${formatErrorMessage(err)}`);
    }
  }

  // Fall back to WASM decoders when ffmpeg is unavailable.
  debugLog(`[audio-convert] fallback: trying WASM decoders for ${ext}`);

  if (ext === ".pcm") {
    const pcmBuf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
    return silkBuffer.toString("base64");
  }

  if (ext === ".wav" || (buf.length >= 4 && buf.toString("ascii", 0, 4) === "RIFF")) {
    const wavInfo = parseWavFallback(buf);
    if (wavInfo) {
      const { silkBuffer } = await pcmToSilk(wavInfo, targetRate);
      return silkBuffer.toString("base64");
    }
  }

  if (ext === ".mp3" || ext === ".mpeg") {
    const pcmBuf = await wasmDecodeMp3ToPCM(buf, targetRate);
    if (pcmBuf) {
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      debugLog(`[audio-convert] WASM: MP3 → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString("base64");
    }
  }

  const installHint = isWindows()
    ? "Install ffmpeg with choco install ffmpeg, scoop install ffmpeg, or from https://ffmpeg.org"
    : process.platform === "darwin"
      ? "Install ffmpeg with brew install ffmpeg"
      : "Install ffmpeg with sudo apt install ffmpeg or sudo yum install ffmpeg";
  debugError(`[audio-convert] unsupported format: ${ext} (no ffmpeg available). ${installHint}`);
  return null;
}

/**
 * Wait until a file exists and its size has stabilized.
 */
export async function waitForFile(
  filePath: string,
  timeoutMs: number = 30000,
  pollMs: number = 500,
): Promise<number> {
  const start = Date.now();
  let lastSize = -1;
  let stableCount = 0;
  let fileExists = false;
  let fileAppearedAt = 0;
  let pollCount = 0;

  const emptyGiveUpMs = 10000;
  const noFileGiveUpMs = 15000;

  while (Date.now() - start < timeoutMs) {
    pollCount++;
    try {
      const stat = fs.statSync(filePath);
      if (!fileExists) {
        fileExists = true;
        fileAppearedAt = Date.now();
        debugLog(
          `[audio-convert] waitForFile: file appeared (${stat.size} bytes, after ${Date.now() - start}ms): ${path.basename(filePath)}`,
        );
      }
      if (stat.size > 0) {
        if (stat.size === lastSize) {
          stableCount++;
          if (stableCount >= 2) {
            debugLog(
              `[audio-convert] waitForFile: ready (${stat.size} bytes, waited ${Date.now() - start}ms, polls=${pollCount})`,
            );
            return stat.size;
          }
        } else {
          stableCount = 0;
        }
        lastSize = stat.size;
      } else {
        if (Date.now() - fileAppearedAt > emptyGiveUpMs) {
          debugError(
            `[audio-convert] waitForFile: file still empty after ${emptyGiveUpMs}ms, giving up: ${path.basename(filePath)}`,
          );
          return 0;
        }
      }
    } catch {
      if (!fileExists && Date.now() - start > noFileGiveUpMs) {
        debugError(
          `[audio-convert] waitForFile: file never appeared after ${noFileGiveUpMs}ms, giving up: ${path.basename(filePath)}`,
        );
        return 0;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  try {
    const finalStat = fs.statSync(filePath);
    if (finalStat.size > 0) {
      debugWarn(
        `[audio-convert] waitForFile: timeout but file has data (${finalStat.size} bytes), using it`,
      );
      return finalStat.size;
    }
    debugError(
      `[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file exists but empty (0 bytes): ${path.basename(filePath)}`,
    );
  } catch {
    debugError(
      `[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file never appeared: ${path.basename(filePath)}`,
    );
  }
  return 0;
}

/** Delegate ffmpeg detection to the platform helper. */
async function checkFfmpeg(): Promise<string | null> {
  return detectFfmpeg();
}

/** Convert arbitrary audio into mono 24 kHz PCM s16le with ffmpeg. */
function ffmpegToPCM(
  ffmpegCmd: string,
  inputPath: string,
  sampleRate: number = 24000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i",
      inputPath,
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-acodec",
      "pcm_s16le",
      "-v",
      "error",
      "pipe:1",
    ];
    execFile(
      ffmpegCmd,
      args,
      {
        maxBuffer: 50 * 1024 * 1024,
        encoding: "buffer",
        ...(isWindows() ? { windowsHide: true } : {}),
      },
      (err, stdout) => {
        if (err) {
          reject(new Error(`ffmpeg failed: ${err.message}`));
          return;
        }
        resolve(stdout as unknown as Buffer);
      },
    );
  });
}

/** Decode MP3 into PCM through mpg123-decoder when ffmpeg is unavailable. */
async function wasmDecodeMp3ToPCM(buf: Buffer, targetRate: number): Promise<Buffer | null> {
  try {
    const { MPEGDecoder } = await import("mpg123-decoder");
    debugLog(`[audio-convert] WASM MP3 decode: size=${buf.length} bytes`);
    const decoder = new MPEGDecoder();
    await decoder.ready;

    const decoded = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    decoder.free();

    if (decoded.samplesDecoded === 0 || decoded.channelData.length === 0) {
      debugError(
        `[audio-convert] WASM MP3 decode: no samples (samplesDecoded=${decoded.samplesDecoded})`,
      );
      return null;
    }

    debugLog(
      `[audio-convert] WASM MP3 decode: samples=${decoded.samplesDecoded}, sampleRate=${decoded.sampleRate}, channels=${decoded.channelData.length}`,
    );

    // Down-mix multi-channel float PCM into mono.
    let floatMono: Float32Array;
    if (decoded.channelData.length === 1) {
      floatMono = decoded.channelData[0];
    } else {
      floatMono = new Float32Array(decoded.samplesDecoded);
      const channels = decoded.channelData.length;
      for (let i = 0; i < decoded.samplesDecoded; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
          sum += decoded.channelData[ch][i];
        }
        floatMono[i] = sum / channels;
      }
    }

    // Convert Float32 PCM into s16le.
    const s16 = new Uint8Array(floatMono.length * 2);
    const view = new DataView(s16.buffer);
    for (let i = 0; i < floatMono.length; i++) {
      const clamped = Math.max(-1, Math.min(1, floatMono[i]));
      const val = clamped < 0 ? clamped * 32768 : clamped * 32767;
      view.setInt16(i * 2, Math.round(val), true);
    }

    // Resample with simple linear interpolation.
    let pcm: Uint8Array = s16;
    if (decoded.sampleRate !== targetRate) {
      const inputSamples = s16.length / 2;
      const outputSamples = Math.round((inputSamples * targetRate) / decoded.sampleRate);
      const output = new Uint8Array(outputSamples * 2);
      const inView = new DataView(s16.buffer, s16.byteOffset, s16.byteLength);
      const outView = new DataView(output.buffer, output.byteOffset, output.byteLength);
      for (let i = 0; i < outputSamples; i++) {
        const srcIdx = (i * decoded.sampleRate) / targetRate;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, inputSamples - 1);
        const frac = srcIdx - idx0;
        const s0 = inView.getInt16(idx0 * 2, true);
        const s1 = inView.getInt16(idx1 * 2, true);
        const sample = Math.round(s0 + (s1 - s0) * frac);
        outView.setInt16(i * 2, Math.max(-32768, Math.min(32767, sample)), true);
      }
      pcm = output;
    }

    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  } catch (err) {
    debugError(`[audio-convert] WASM MP3 decode failed: ${formatErrorMessage(err)}`);
    if (err instanceof Error && err.stack) {
      debugError(`[audio-convert] stack: ${err.stack}`);
    }
    return null;
  }
}

/** Normalize file extensions to lowercased dotted form. */
function normalizeFormats(formats: string[]): string[] {
  return formats.map((f) => {
    const lower = normalizeLowercaseStringOrEmpty(f);
    return lower.startsWith(".") ? lower : `.${lower}`;
  });
}

/** Parse standard PCM WAV as a no-ffmpeg fallback. */
function parseWavFallback(buf: Buffer): Buffer | null {
  if (buf.length < 44) {
    return null;
  }
  if (buf.toString("ascii", 0, 4) !== "RIFF") {
    return null;
  }
  if (buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  if (buf.toString("ascii", 12, 16) !== "fmt ") {
    return null;
  }

  const audioFormat = buf.readUInt16LE(20);
  if (audioFormat !== 1) {
    return null;
  }

  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) {
    return null;
  }

  // Find the PCM data chunk.
  let offset = 36;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, buf.length);
      let pcm = new Uint8Array(buf.buffer, buf.byteOffset + dataStart, dataEnd - dataStart);

      // Downmix multi-channel audio to mono.
      if (channels > 1) {
        const samplesPerCh = pcm.length / (2 * channels);
        const mono = new Uint8Array(samplesPerCh * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
        for (let i = 0; i < samplesPerCh; i++) {
          let sum = 0;
          for (let ch = 0; ch < channels; ch++) {
            sum += inV.getInt16((i * channels + ch) * 2, true);
          }
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sum / channels))), true);
        }
        pcm = mono;
      }

      // Resample with simple linear interpolation.
      const targetRate = 24000;
      if (sampleRate !== targetRate) {
        const inSamples = pcm.length / 2;
        const outSamples = Math.round((inSamples * targetRate) / sampleRate);
        const out = new Uint8Array(outSamples * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(out.buffer, out.byteOffset, out.byteLength);
        for (let i = 0; i < outSamples; i++) {
          const src = (i * sampleRate) / targetRate;
          const i0 = Math.floor(src);
          const i1 = Math.min(i0 + 1, inSamples - 1);
          const f = src - i0;
          const s0 = inV.getInt16(i0 * 2, true);
          const s1 = inV.getInt16(i1 * 2, true);
          outV.setInt16(
            i * 2,
            Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * f))),
            true,
          );
        }
        pcm = out;
      }

      return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }
    offset += 8 + chunkSize;
  }

  return null;
}
