import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";

const XIAOMI_API_KEY = process.env.XIAOMI_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled() && XIAOMI_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

const registerXiaomiPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "xiaomi",
    name: "Xiaomi Provider",
  });

describeLive("xiaomi plugin live", () => {
  it("synthesizes MiMo TTS through the registered speech provider", async () => {
    const { speechProviders } = await registerXiaomiPlugin();
    const provider = requireRegisteredProvider(speechProviders, "xiaomi");

    const audioFile = await provider.synthesize({
      text: "OpenClaw Xiaomi MiMo text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: XIAOMI_API_KEY, format: "mp3", voice: "mimo_default" },
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);

  it("synthesizes MiMo TTS as an Opus voice note", async () => {
    const { speechProviders } = await registerXiaomiPlugin();
    const provider = requireRegisteredProvider(speechProviders, "xiaomi");

    const voiceNote = await provider.synthesize({
      text: "OpenClaw Xiaomi MiMo voice note test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: XIAOMI_API_KEY, format: "mp3", voice: "mimo_default" },
      target: "voice-note",
      timeoutMs: 90_000,
    });

    expect(voiceNote.outputFormat).toBe("opus");
    expect(voiceNote.fileExtension).toBe(".opus");
    expect(voiceNote.voiceCompatible).toBe(true);
    expect(voiceNote.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);
});
