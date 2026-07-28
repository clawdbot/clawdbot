import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  expectOpenClawLiveTranscriptMarker,
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
});
