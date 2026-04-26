import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import {
  normalizeTranscriptForMatch,
  runRealtimeSttLiveTest,
  synthesizeElevenLabsLiveSpeech,
} from "../../test/helpers/stt-live-audio.js";
import plugin from "./index.js";
import { elevenLabsMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildElevenLabsRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["ELEVENLABS_LIVE_TEST"]);
const describeLive = LIVE && ELEVENLABS_KEY ? describe : describe.skip;

const registerElevenLabsPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "elevenlabs",
    name: "ElevenLabs Speech",
  });

describeLive("elevenlabs plugin live", () => {
  it("synthesizes speech through the registered provider with eleven_v3", async () => {
    const { speechProviders } = await registerElevenLabsPlugin();
    const provider = requireRegisteredProvider(speechProviders, "elevenlabs");

    const audioFile = await provider.synthesize({
      text: "OpenClaw ElevenLabs eleven v three text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: ELEVENLABS_KEY, modelId: "eleven_v3" },
      target: "audio-file",
      timeoutMs: 45_000,
    });

    expect(audioFile.outputFormat).toBe("mp3_44100_128");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 60_000);

  it("transcribes synthesized speech through the media provider", async () => {
    const phrase = "Testing OpenClaw ElevenLabs speech to text integration OK.";
    const audio = await synthesizeElevenLabsLiveSpeech({
      text: phrase,
      apiKey: ELEVENLABS_KEY,
      outputFormat: "mp3_44100_128",
      timeoutMs: 30_000,
    });

    const transcript = await elevenLabsMediaUnderstandingProvider.transcribeAudio?.({
      buffer: audio,
      fileName: "elevenlabs-live.mp3",
      mime: "audio/mpeg",
      apiKey: ELEVENLABS_KEY,
      timeoutMs: 60_000,
    });

    const normalized = normalizeTranscriptForMatch(transcript?.text ?? "");
    expect(normalized).toContain("openclaw");
    expect(normalized).toMatch(/(?:elevenlabs|11labs)/);
  }, 90_000);

  it("streams realtime STT through the registered transcription provider", async () => {
    const provider = buildElevenLabsRealtimeTranscriptionProvider();
    const phrase = "Testing OpenClaw ElevenLabs realtime transcription integration OK.";
    const speech = await synthesizeElevenLabsLiveSpeech({
      text: phrase,
      apiKey: ELEVENLABS_KEY,
      outputFormat: "ulaw_8000",
      timeoutMs: 30_000,
    });

    await runRealtimeSttLiveTest({
      provider,
      providerConfig: {
        apiKey: ELEVENLABS_KEY,
        audioFormat: "ulaw_8000",
        sampleRate: 8000,
        commitStrategy: "vad",
        languageCode: "en",
      },
      audio: Buffer.concat([Buffer.alloc(4000, 0xff), speech, Buffer.alloc(8000, 0xff)]),
      closeBeforeWait: true,
    });
  }, 90_000);
});
