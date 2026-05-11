/**
 * Discord Voice Message Support
 *
 * Implements sending voice messages via Discord's API.
 * Voice messages require:
 * - OGG/Opus format audio
 * - Waveform data (base64 encoded, up to 256 samples, 0-255 values)
 * - Duration in seconds
 * - Message flag 8192 (IS_VOICE_MESSAGE)
 * - No other content (text, embeds, etc.)
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  parseFfprobeCodecAndSampleRate,
  runFfmpeg,
  runFfprobe,
} from "openclaw/plugin-sdk/media-runtime";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "openclaw/plugin-sdk/media-runtime";
import { unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";
import type { RetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { DiscordError, RateLimitError, type RequestClient } from "./internal/discord.js";
import { readDiscordMessage, readRetryAfter } from "./internal/rest-errors.js";

const DISCORD_VOICE_MESSAGE_FLAG = 1 << 13;
const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;
const WAVEFORM_SAMPLES = 256;
const DISCORD_OPUS_SAMPLE_RATE_HZ = 48_000;

async function runFfmpegToOutput(params: {
  outputPath: string;
  buildArgs: (tempPath: string) => string[];
}): Promise<void> {
  const rootDir = path.dirname(params.outputPath);
  await fs.mkdir(rootDir, { recursive: true });
  await writeExternalFileWithinRoot({
    rootDir,
    path: path.basename(params.outputPath),
    write: async (tempPath) => {
      await runFfmpeg(params.buildArgs(tempPath));
    },
  });
}

function createRateLimitError(
  response: Response,
  body: { message: string; retry_after: number; global: boolean },
  request?: Request,
): RateLimitError {
  const fallbackRequest =
    request ??
    new Request("https://discord.com/api/v10/channels/voice/messages", {
      method: "POST",
    });
  const RateLimitErrorCtor = RateLimitError as unknown as new (
    response: Response,
    body: { message: string; retry_after: number; global: boolean },
    request?: Request,
  ) => RateLimitError;
  return new RateLimitErrorCtor(response, body, fallbackRequest);
}

export type VoiceMessageMetadata = {
  durationSecs: number;
  waveform: string; // base64 encoded
};

/**
 * Get audio duration using ffprobe
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const stdout = await runFfprobe([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    const duration = Number.parseFloat(stdout.trim());
    if (Number.isNaN(duration)) {
      throw new Error("Could not parse duration");
    }
    return Math.round(duration * 100) / 100; // Round to 2 decimal places
  } catch (err) {
    const errMessage = formatErrorMessage(err);
    throw new Error(`Failed to get audio duration: ${errMessage}`, { cause: err });
  }
}

/**
 * Generate waveform data from audio file using ffmpeg
 * Returns base64 encoded byte array of amplitude samples (0-255)
 */
export async function generateWaveform(filePath: string): Promise<string> {
  try {
    // Extract raw PCM and sample amplitude values
    return await generateWaveformFromPcm(filePath);
  } catch {
    // If PCM extraction fails, generate a placeholder waveform
    return generatePlaceholderWaveform();
  }
}

/**
 * Generate waveform by extracting raw PCM data and sampling amplitudes
 */
async function generateWaveformFromPcm(filePath: string): Promise<string> {
  const tempDir = resolvePreferredOpenClawTmpDir();
  const tempPcm = path.join(tempDir, `waveform-${crypto.randomUUID()}.raw`);

  try {
    // Convert to raw 16-bit signed PCM, mono, 8kHz
    await runFfmpegToOutput({
      outputPath: tempPcm,
      buildArgs: (outputPath) => [
        "-y",
        "-i",
        filePath,
        "-vn",
        "-sn",
        "-dn",
        "-t",
        String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        "-ar",
        "8000",
        outputPath,
      ],
    });

    const pcmData = await fs.readFile(tempPcm);
    const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);

    // Sample the PCM data to get WAVEFORM_SAMPLES points
    const step = Math.max(1, Math.floor(samples.length / WAVEFORM_SAMPLES));
    const waveform: number[] = [];

    for (let i = 0; i < WAVEFORM_SAMPLES && i * step < samples.length; i++) {
      // Get average absolute amplitude for this segment
      let sum = 0;
      let count = 0;
      for (let j = 0; j < step && i * step + j < samples.length; j++) {
        sum += Math.abs(samples[i * step + j]);
        count++;
      }
      const avg = count > 0 ? sum / count : 0;
      // Normalize to 0-255 (16-bit signed max is 32767)
      const normalized = Math.min(255, Math.round((avg / 32767) * 255));
      waveform.push(normalized);
    }

    // Pad with zeros if we don't have enough samples
    while (waveform.length < WAVEFORM_SAMPLES) {
      waveform.push(0);
    }

    return Buffer.from(waveform).toString("base64");
  } finally {
    await unlinkIfExists(tempPcm);
  }
}

/**
 * Generate a placeholder waveform (for when audio processing fails)
 */
function generatePlaceholderWaveform(): string {
  // Generate a simple sine-wave-like pattern
  const waveform: number[] = [];
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    const value = Math.round(128 + 64 * Math.sin((i / WAVEFORM_SAMPLES) * Math.PI * 8));
    waveform.push(Math.min(255, Math.max(0, value)));
  }
  return Buffer.from(waveform).toString("base64");
}

/**
 * Convert audio file to OGG/Opus format if needed
 * Returns path to the OGG file (may be same as input if already OGG/Opus)
 */
export async function ensureOggOpus(filePath: string): Promise<{ path: string; cleanup: boolean }> {
  const trimmed = filePath.trim();
  // Defense-in-depth: callers should never hand ffmpeg/ffprobe a URL/protocol path.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(
      `Voice message conversion requires a local file path; received a URL/protocol source: ${trimmed}`,
    );
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));

  // Check if already OGG
  if (ext === ".ogg") {
    // Fast-path only when the file is Opus at Discord's expected 48kHz.
    try {
      const stdout = await runFfprobe([
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate",
        "-of",
        "csv=p=0",
        filePath,
      ]);
      const { codec, sampleRateHz } = parseFfprobeCodecAndSampleRate(stdout);
      if (codec === "opus" && sampleRateHz === DISCORD_OPUS_SAMPLE_RATE_HZ) {
        return { path: filePath, cleanup: false };
      }
    } catch {
      // If probe fails, convert anyway
    }
  }

  // Convert to OGG/Opus
  // Always resample to 48kHz to ensure Discord voice messages play at correct speed
  // (Discord expects 48kHz; lower sample rates like 24kHz from some TTS providers cause 0.5x playback)
  const tempDir = resolvePreferredOpenClawTmpDir();
  const outputPath = path.join(tempDir, `voice-${crypto.randomUUID()}.ogg`);

  await runFfmpegToOutput({
    outputPath,
    buildArgs: (tempPath) => [
      "-y",
      "-i",
      filePath,
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
      "-ar",
      String(DISCORD_OPUS_SAMPLE_RATE_HZ),
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      tempPath,
    ],
  });

  return { path: outputPath, cleanup: true };
}

/**
 * Get voice message metadata (duration and waveform)
 */
export async function getVoiceMessageMetadata(filePath: string): Promise<VoiceMessageMetadata> {
  const [durationSecs, waveform] = await Promise.all([
    getAudioDuration(filePath),
    generateWaveform(filePath),
  ]);

  return { durationSecs, waveform };
}

type UploadUrlResponse = {
  attachments: Array<{
    id: number;
    upload_url: string;
    upload_filename: string;
  }>;
};

function coerceDiscordErrorBody(raw: string): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw.slice(0, 200) };
  }
}

async function createVoiceRequestError(
  response: Response,
  fallbackMessage: string,
): Promise<Error> {
  const raw = await response.text().catch(() => "");
  const parsed = coerceDiscordErrorBody(raw);
  if (response.status === 429) {
    throw createRateLimitError(response, {
      message: readDiscordMessage(parsed, "You are being rate limited."),
      retry_after: readRetryAfter(parsed, response, 1),
      global:
        parsed && typeof parsed === "object" && "global" in parsed
          ? Boolean((parsed as { global?: unknown }).global)
          : false,
    });
  }
  return new DiscordError(
    response,
    parsed ?? {
      message: fallbackMessage,
    },
  );
}

async function requestVoiceUploadUrl(params: {
  rest: RequestClient;
  channelId: string;
  botToken: string;
  filename: string;
  fileSize: number;
}): Promise<UploadUrlResponse> {
  const url = `${params.rest.options?.baseUrl ?? "https://discord.com/api"}/channels/${params.channelId}/attachments`;
  const uploadUrlInit: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bot ${params.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: [{ filename: params.filename, file_size: params.fileSize, id: "0" }],
    }),
  };
  const { response: res, release } = await fetchWithSsrFGuard({
    url,
    init: uploadUrlInit,
    auditContext: "discord.voice.upload-url",
  });
  try {
    if (!res.ok) {
      throw await createVoiceRequestError(res, "Upload URL request failed");
    }
    return (await res.json()) as UploadUrlResponse;
  } finally {
    await release();
  }
}

async function uploadVoiceAttachment(params: {
  uploadUrl: string;
  audioBuffer: Buffer;
}): Promise<void> {
  const { response: uploadResponse, release } = await fetchWithSsrFGuard({
    url: params.uploadUrl,
    init: {
      method: "PUT",
      headers: {
        "Content-Type": "audio/ogg",
      },
      body: new Uint8Array(params.audioBuffer),
    },
    auditContext: "discord.voice.attachment-upload",
  });

  try {
    if (!uploadResponse.ok) {
      throw await createVoiceRequestError(uploadResponse, "Failed to upload voice message");
    }
  } finally {
    await release();
  }
}

/**
 * Send a voice message to Discord
 *
 * This follows Discord's voice message protocol:
 * 1. Request upload URL from Discord
 * 2. Upload the OGG file to the provided URL
 * 3. Send the message with flag 8192 and attachment metadata
 */
export async function sendDiscordVoiceMessage(
  rest: RequestClient,
  channelId: string,
  audioBuffer: Buffer,
  metadata: VoiceMessageMetadata,
  replyTo: string | undefined,
  request: RetryRunner,
  silent?: boolean,
  token?: string,
): Promise<{ id: string; channel_id: string }> {
  const filename = "voice-message.ogg";
  const fileSize = audioBuffer.byteLength;

  // Step 1: Request upload URL from Discord
  // RequestClient auto-converts "files" bodies to multipart/form-data, but Discord's
  // /attachments endpoint expects JSON, so this path uses a guarded raw HTTP call.
  const botToken = token;
  if (!botToken) {
    throw new Error("Discord bot token is required for voice message upload");
  }
  const { upload_filename } = await request(async () => {
    const uploadUrlResponse = await requestVoiceUploadUrl({
      rest,
      channelId,
      botToken,
      filename,
      fileSize,
    });

    if (!uploadUrlResponse.attachments?.[0]) {
      throw new Error("Failed to get upload URL for voice message");
    }

    const attachment = uploadUrlResponse.attachments[0];
    await uploadVoiceAttachment({
      uploadUrl: attachment.upload_url,
      audioBuffer,
    });
    return attachment;
  }, "voice-upload");

  // Step 3: Send the message with voice message flag and metadata
  const flags = silent
    ? DISCORD_VOICE_MESSAGE_FLAG | SUPPRESS_NOTIFICATIONS_FLAG
    : DISCORD_VOICE_MESSAGE_FLAG;
  const messagePayload: {
    flags: number;
    attachments: Array<{
      id: string;
      filename: string;
      uploaded_filename: string;
      duration_secs: number;
      waveform: string;
    }>;
    message_reference?: { message_id: string; fail_if_not_exists: boolean };
  } = {
    flags,
    attachments: [
      {
        id: "0",
        filename,
        uploaded_filename: upload_filename,
        duration_secs: metadata.durationSecs,
        waveform: metadata.waveform,
      },
    ],
  };

  // Note: Voice messages cannot have content, but can have message_reference for replies
  if (replyTo) {
    messagePayload.message_reference = {
      message_id: replyTo,
      fail_if_not_exists: false,
    };
  }

  const res = (await request(
    () =>
      rest.post(`/channels/${channelId}/messages`, {
        body: messagePayload,
      }) as Promise<{ id: string; channel_id: string }>,
    "voice-message",
  )) as { id: string; channel_id: string };

  return res;
}
