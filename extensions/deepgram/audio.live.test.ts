// Deepgram tests cover audio plugin behavior.
import { spawnSync } from "node:child_process";
import { runRealtimeSttLiveTest } from "openclaw/plugin-sdk/provider-test-contracts";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { transcribeDeepgramAudio } from "./audio.js";
import { buildDeepgramRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY ?? "";
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL?.trim() || "nova-3";
const DEEPGRAM_BASE_URL = process.env.DEEPGRAM_BASE_URL?.trim();
const SAMPLE_URL =
  process.env.DEEPGRAM_SAMPLE_URL?.trim() ||
  "https://static.deepgram.com/examples/Bueller-Life-moves-pretty-fast.wav";
const LIVE = isLiveTestEnabled(["DEEPGRAM_LIVE_TEST"]);

const describeLive = LIVE && DEEPGRAM_KEY ? describe : describe.skip;

async function fetchSampleBuffer(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Sample download failed (HTTP ${res.status})`);
    }
    const data = await res.arrayBuffer();
    return Buffer.from(data);
  } finally {
    clearTimeout(timer);
  }
}

function convertWavToMulaw8k(wav: Buffer): Buffer {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "mulaw",
      "-ar",
      "8000",
      "-ac",
      "1",
      "pipe:1",
    ],
    { input: wav, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout;
}

describeLive("deepgram live", () => {
  it("transcribes sample audio", async () => {
    const buffer = await fetchSampleBuffer(SAMPLE_URL, 15000);
    const result = await transcribeDeepgramAudio({
      buffer,
      fileName: "sample.wav",
      mime: "audio/wav",
      apiKey: DEEPGRAM_KEY,
      model: DEEPGRAM_MODEL,
      baseUrl: DEEPGRAM_BASE_URL,
      timeoutMs: 20000,
    });
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, 30000);

  it("streams realtime STT through the registered transcription provider", async () => {
    const provider = buildDeepgramRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession,
    });
    const speech = convertWavToMulaw8k(await fetchSampleBuffer(SAMPLE_URL, 15_000));
    expect(speech.byteLength).toBeGreaterThan(0);

    await runRealtimeSttLiveTest({
      provider,
      providerConfig: {
        apiKey: DEEPGRAM_KEY,
        language: "en-US",
        endpointingMs: 500,
      },
      audio: Buffer.concat([Buffer.alloc(4000, 0xff), speech, Buffer.alloc(8000, 0xff)]),
      expectedNormalizedText: "lifemovesprettyfast",
    });
  }, 90_000);
});
