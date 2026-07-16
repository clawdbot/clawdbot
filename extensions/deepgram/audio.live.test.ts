import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import { transcribeDeepgramAudio } from "./audio.js";

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
});
