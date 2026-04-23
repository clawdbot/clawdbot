import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/realtime-transcription";
import { expect } from "vitest";

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_TTS_MODEL_ID = "eleven_multilingual_v2";

export function normalizeTranscriptForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export async function waitForLiveExpectation(expectation: () => void, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      expectation();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

export async function synthesizeElevenLabsLiveSpeech(params: {
  text: string;
  apiKey: string;
  outputFormat: "mp3_44100_128" | "ulaw_8000";
  timeoutMs?: number;
}): Promise<Buffer> {
  const baseUrl = process.env.ELEVENLABS_BASE_URL?.trim() || DEFAULT_ELEVENLABS_BASE_URL;
  const voiceId = process.env.ELEVENLABS_LIVE_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 30_000);
  try {
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}/v1/text-to-speech/${voiceId}`);
    url.searchParams.set("output_format", params.outputFormat);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": params.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: params.text,
        model_id: DEFAULT_ELEVENLABS_TTS_MODEL_ID,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
          speed: 1,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs live TTS failed (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function streamAudioForLiveTest(params: {
  audio: Buffer;
  sendAudio: (chunk: Buffer) => void;
  chunkSize?: number;
  delayMs?: number;
}) {
  const chunkSize = params.chunkSize ?? 160;
  const delayMs = params.delayMs ?? 5;
  for (let offset = 0; offset < params.audio.byteLength; offset += chunkSize) {
    params.sendAudio(params.audio.subarray(offset, offset + chunkSize));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export async function runRealtimeSttLiveTest(params: {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  audio: Buffer;
  expectedNormalizedText?: string;
  timeoutMs?: number;
  closeBeforeWait?: boolean;
  chunkSize?: number;
  delayMs?: number;
}): Promise<{ transcripts: string[]; partials: string[]; errors: Error[] }> {
  const transcripts: string[] = [];
  const partials: string[] = [];
  const errors: Error[] = [];
  const expected = params.expectedNormalizedText ?? "openclaw";
  const session = params.provider.createSession({
    providerConfig: params.providerConfig,
    onPartial: (partial) => partials.push(partial),
    onTranscript: (transcript) => transcripts.push(transcript),
    onError: (error) => errors.push(error),
  });

  try {
    await session.connect();
    await streamAudioForLiveTest({
      audio: params.audio,
      sendAudio: (chunk) => session.sendAudio(chunk),
      chunkSize: params.chunkSize,
      delayMs: params.delayMs,
    });
    if (params.closeBeforeWait) {
      session.close();
    }

    await waitForLiveExpectation(() => {
      if (errors[0]) {
        throw errors[0];
      }
      expect(normalizeTranscriptForMatch(transcripts.join(" "))).toContain(expected);
    }, params.timeoutMs ?? 60_000);
  } finally {
    session.close();
  }

  expect(partials.length + transcripts.length).toBeGreaterThan(0);
  return { transcripts, partials, errors };
}
