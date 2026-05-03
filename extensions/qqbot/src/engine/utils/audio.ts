/**
 * Audio format conversion utilities.
 * 音频格式转换工具。
 *
 * Handles SILK ↔ PCM ↔ WAV ↔ MP3 conversions for QQ Bot voice messaging.
 * Uses WASM decoders (silk-wasm, mpg123-decoder) and direct QQ-native uploads
 * without launching native subprocesses.
 *
 * Self-contained within engine/ — no framework SDK dependency.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { formatErrorMessage } from "./format.js";
import { debugLog, debugError, debugWarn } from "./log.js";
import { normalizeLowercaseStringOrEmpty as normalizeLowercase } from "./string-normalize.js";

type SilkWasm = typeof import("silk-wasm");
let _silkWasmPromise: Promise<SilkWasm | null> | null = null;

/** Lazy-load the silk-wasm module (singleton cache; returns null on failure). */
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

/** Wrap raw PCM s16le data into a standard WAV file. */
export function pcmToWav(
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

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

/** Strip the AMR header that may be present in QQ voice payloads. */
export function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from("#!AMR\n");
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

/** Convert a SILK or AMR voice file to WAV format. */
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

/** Check whether an attachment is a voice file (by MIME type or extension). */
export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === "voice" || att.content_type?.startsWith("audio/")) {
    return true;
  }
  const ext = att.filename ? normalizeLowercase(path.extname(att.filename)) : "";
  return [".amr", ".silk", ".slk", ".slac"].includes(ext);
}

/** Check whether a file path is a known audio format. */
export function isAudioFile(filePath: string, mimeType?: string): boolean {
  if (mimeType) {
    if (mimeType === "voice" || mimeType.startsWith("audio/")) {
      return true;
    }
  }
  const ext = normalizeLowercase(path.extname(filePath));
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

const QQ_NATIVE_VOICE_MIMES = new Set([
  "audio/silk",
  "audio/amr",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
]);

const QQ_NATIVE_VOICE_EXTS = new Set([".silk", ".slk", ".amr", ".wav", ".mp3"]);

/** Check whether a voice file needs transcoding for upload (QQ-native formats skip it). */
export function shouldTranscodeVoice(filePath: string, mimeType?: string): boolean {
  if (mimeType && QQ_NATIVE_VOICE_MIMES.has(normalizeLowercase(mimeType))) {
    return false;
  }
  const ext = normalizeLowercase(path.extname(filePath));
  if (QQ_NATIVE_VOICE_EXTS.has(ext)) {
    return false;
  }
  return isAudioFile(filePath, mimeType);
}

const QQ_NATIVE_UPLOAD_FORMATS = [".wav", ".mp3", ".silk"];

function normalizeFormats(formats: string[]): string[] {
  return formats.map((f) => {
    const lower = normalizeLowercase(f);
    return lower.startsWith(".") ? lower : `.${lower}`;
  });
}

/**
 * Convert a local audio file to Base64-encoded SILK for QQ API upload.
 *
 * Attempts conversion via direct QQ-native upload → WASM decoders → null fallback chain.
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

  const ext = normalizeLowercase(path.extname(filePath));
  const uploadFormats = directUploadFormats
    ? normalizeFormats(directUploadFormats)
    : QQ_NATIVE_UPLOAD_FORMATS;
  if (uploadFormats.includes(ext)) {
    debugLog(`[audio-convert] direct upload (QQ native format): ${ext} (${buf.length} bytes)`);
    return buf.toString("base64");
  }

  if ([".slk", ".slac"].includes(ext)) {
    const stripped = stripAmrHeader(buf);
    const raw = new Uint8Array(stripped.buffer, stripped.byteOffset, stripped.byteLength);
    const silk = await loadSilkWasm();
    if (silk?.isSilk(raw)) {
      debugLog(`[audio-convert] SILK file, direct use: ${filePath} (${buf.length} bytes)`);
      return buf.toString("base64");
    }
  }

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

  debugError(
    `[audio-convert] unsupported format without native subprocess conversion: ${ext}. Use QQ-native voice formats or WAV/MP3/PCM inputs.`,
  );
  return null;
}

/**
 * Wait for a file to appear and stabilize, then return its final size.
 *
 * Polls at `pollMs` intervals; returns 0 on timeout or persistent empty file.
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

/** Encode PCM s16le data into SILK format. */
async function pcmToSilk(
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

/** Decode MP3 to PCM via mpg123-decoder WASM. */
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

    const s16 = new Uint8Array(floatMono.length * 2);
    const view = new DataView(s16.buffer);
    for (let i = 0; i < floatMono.length; i++) {
      const clamped = Math.max(-1, Math.min(1, floatMono[i]));
      const val = clamped < 0 ? clamped * 32768 : clamped * 32767;
      view.setInt16(i * 2, Math.round(val), true);
    }

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

/** Parse a standard PCM WAV and extract mono 24 kHz PCM data. */
export function parseWavFallback(buf: Buffer): Buffer | null {
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

  let offset = 36;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, buf.length);
      let pcm = new Uint8Array(buf.buffer, buf.byteOffset + dataStart, dataEnd - dataStart);

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
