import {
  normalizeTranscriptForMatch,
  runRealtimeSttLiveTest,
  synthesizeElevenLabsLiveSpeech,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

const MISTRAL_KEY = process.env.MISTRAL_API_KEY ?? "";
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["MISTRAL_LIVE_TEST"]);
const describeLive = LIVE && MISTRAL_KEY && ELEVENLABS_KEY ? describe : describe.skip;

describeLive("mistral plugin live", () => {
  it("transcribes synthesized speech through the media provider", async () => {
    const phrase = "Testing OpenClaw Mistral speech to text integration OK.";
    const audio = await synthesizeElevenLabsLiveSpeech({
      text: phrase,
      apiKey: ELEVENLABS_KEY,
      outputFormat: "mp3_44100_128",
      timeoutMs: 30_000,
    });

    const transcript = await mistralMediaUnderstandingProvider.transcribeAudio?.({
      buffer: audio,
      fileName: "mistral-live.mp3",
      mime: "audio/mpeg",
      apiKey: MISTRAL_KEY,
      timeoutMs: 60_000,
    });

    const normalized = normalizeTranscriptForMatch(transcript?.text ?? "");
    expect(normalized).toContain("openclaw");
    expect(normalized).toContain("mistral");
  }, 90_000);

  it("streams realtime STT through the registered transcription provider", async () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const phrase = "Testing OpenClaw Mistral realtime transcription integration OK.";
    const speech = await synthesizeElevenLabsLiveSpeech({
      text: phrase,
      apiKey: ELEVENLABS_KEY,
      outputFormat: "ulaw_8000",
      timeoutMs: 30_000,
    });
    expect(speech.byteLength).toBeGreaterThan(0);

    await runRealtimeSttLiveTest({
      provider,
      providerConfig: {
        apiKey: MISTRAL_KEY,
        sampleRate: 8000,
        encoding: "pcm_mulaw",
        targetStreamingDelayMs: 800,
      },
      audio: Buffer.concat([Buffer.alloc(4000, 0xff), speech, Buffer.alloc(8000, 0xff)]),
      closeBeforeWait: true,
    });
  }, 90_000);
});
