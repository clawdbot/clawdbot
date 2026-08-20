import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  expectOpenClawLiveTranscriptMarker,
  runRealtimeSttLiveTest,
  normalizeTranscriptForMatch,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { NVIDIA_DEFAULT_ASR_MODEL } from "./nvidia-speech-config.js";

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled() && NVIDIA_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

const registerNvidiaPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "nvidia",
    name: "NVIDIA Provider",
  });

function linearToMulaw(sample: number): number {
  const bias = 132;
  const clip = 32635;
  let next = Math.max(-clip, Math.min(clip, sample));
  const sign = next < 0 ? 0x80 : 0;
  if (next < 0) {
    next = -next;
  }
  next += bias;
  let exponent = 7;
  for (let mask = 0x4000; (next & mask) === 0 && exponent > 0; exponent -= 1) {
    mask >>= 1;
  }
  const mantissa = (next >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function resamplePcmToMulaw8k(pcm: Buffer, inputRate: number): Buffer {
  const inputSamples = Math.floor(pcm.length / 2);
  const outputSamples = Math.floor((inputSamples * 8_000) / inputRate);
  const mulaw = Buffer.alloc(outputSamples);
  for (let i = 0; i < outputSamples; i += 1) {
    const sourceIndex = Math.floor((i * inputRate) / 8_000);
    mulaw[i] = linearToMulaw(pcm.readInt16LE(sourceIndex * 2));
  }
  return mulaw;
}
describeLive("nvidia speech plugin live", () => {
  it("synthesizes Magpie speech and transcribes it with Parakeet", async () => {
    const { mediaProviders, speechProviders } = await registerNvidiaPlugin();
    const speechProvider = requireRegisteredProvider(speechProviders, "nvidia");
    const mediaProvider = requireRegisteredProvider(mediaProviders, "nvidia");
    const phrase = "Open Claw. Open Claw. NVIDIA speech integration test OK.";

    const audioFile = await speechProvider.synthesize({
      text: phrase,
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: NVIDIA_API_KEY },
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("wav");
    expect(audioFile.fileExtension).toBe(".wav");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
    expect(audioFile.audioBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");

    const transcript = await mediaProvider.transcribeAudio?.({
      buffer: audioFile.audioBuffer,
      fileName: "nvidia-speech-live.wav",
      mime: "audio/wav",
      apiKey: NVIDIA_API_KEY,
      timeoutMs: 120_000,
    });

    const normalized = normalizeTranscriptForMatch(transcript?.text ?? "");
    expect(transcript?.model).toBe(NVIDIA_DEFAULT_ASR_MODEL);
    expectOpenClawLiveTranscriptMarker(normalized);
    expect(normalized).toContain("nvidia");
    expect(normalized).toContain("speech");
    expect(normalized).toContain("integration");
  }, 240_000);

  it("streams Magpie audio into Nemotron realtime transcription", async () => {
    const { realtimeTranscriptionProviders, speechProviders } = await registerNvidiaPlugin();
    const speechProvider = requireRegisteredProvider(speechProviders, "nvidia");
    const realtimeProvider = requireRegisteredProvider(realtimeTranscriptionProviders, "nvidia");
    const phrase = "Open Claw NVIDIA realtime transcription integration test OK.";

    const streamed = await speechProvider.streamSynthesize?.({
      text: phrase,
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: NVIDIA_API_KEY, sampleRateHz: 44_100 },
      target: "audio-file",
      timeoutMs: 120_000,
    });
    if (!streamed) {
      throw new Error("NVIDIA Magpie streaming synthesis is unavailable");
    }
    const wav = Buffer.from(await new Response(streamed.audioStream).arrayBuffer());
    await streamed.release?.();
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.byteLength).toBeGreaterThan(512);

    const speech = resamplePcmToMulaw8k(wav.subarray(44), 44_100);
    const audio = Buffer.concat([Buffer.alloc(4_000, 0xff), speech, Buffer.alloc(8_000, 0xff)]);
    const { transcripts, partials } = await runRealtimeSttLiveTest({
      provider: realtimeProvider,
      providerConfig: { apiKey: NVIDIA_API_KEY, language: "en-US" },
      audio,
      expectedNormalizedText: /nvidia.*realtime.*transcription/,
    });
    const normalized = normalizeTranscriptForMatch(transcripts.join(" "));
    expect(normalized).toContain("nvidia");
    expect(normalized).toContain("realtime");
    expect(partials.length + transcripts.length).toBeGreaterThan(0);
  }, 300_000);
});
