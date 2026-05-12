import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const AZURE_SPEECH_KEY =
  process.env.AZURE_SPEECH_KEY?.trim() ??
  process.env.AZURE_SPEECH_API_KEY?.trim() ??
  process.env.SPEECH_KEY?.trim() ??
  "";
const AZURE_SPEECH_REGION =
  process.env.AZURE_SPEECH_REGION?.trim() ?? process.env.SPEECH_REGION?.trim() ?? "";
const LIVE = isLiveTestEnabled() && AZURE_SPEECH_KEY.length > 0 && AZURE_SPEECH_REGION.length > 0;
const describeLive = LIVE ? describe : describe.skip;

const registerAzureSpeechPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "azure-speech",
    name: "Azure Speech",
  });

describeLive("azure speech plugin live", () => {
  it("lists voices through the registered speech provider", async () => {
    const { speechProviders } = await registerAzureSpeechPlugin();
    const provider = requireRegisteredProvider(speechProviders, "azure-speech");

    const voices = await provider.listVoices?.({
      providerConfig: {
        apiKey: AZURE_SPEECH_KEY,
        region: AZURE_SPEECH_REGION,
      },
    });

    expect(voices?.length).toBeGreaterThan(100);
    expect(voices?.some((voice) => voice.id === "en-US-JennyNeural")).toBe(true);
  }, 120_000);

  it("synthesizes MP3, native Ogg/Opus voice notes, and telephony audio", async () => {
    const { speechProviders } = await registerAzureSpeechPlugin();
    const provider = requireRegisteredProvider(speechProviders, "azure-speech");
    const providerConfig = {
      apiKey: AZURE_SPEECH_KEY,
      region: AZURE_SPEECH_REGION,
      voice: "en-US-JennyNeural",
      lang: "en-US",
    };

    const audioFile = await provider.synthesize({
      text: "OpenClaw Azure Speech text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("audio-24khz-48kbitrate-mono-mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.voiceCompatible).toBe(false);
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);

    const voiceNote = await provider.synthesize({
      text: "OpenClaw Azure Speech voice note integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      target: "voice-note",
      timeoutMs: 90_000,
    });

    expect(voiceNote.outputFormat).toBe("ogg-24khz-16bit-mono-opus");
    expect(voiceNote.fileExtension).toBe(".ogg");
    expect(voiceNote.voiceCompatible).toBe(true);
    expect(voiceNote.audioBuffer.byteLength).toBeGreaterThan(128);
    expect(voiceNote.audioBuffer.subarray(0, 4).toString("ascii")).toBe("OggS");

    const telephony = await provider.synthesizeTelephony?.({
      text: "OpenClaw Azure Speech telephony check OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      timeoutMs: 90_000,
    });
    if (!telephony) {
      throw new Error("Azure Speech telephony synthesis did not return audio");
    }
    expect(telephony.outputFormat).toBe("raw-8khz-8bit-mono-mulaw");
    expect(telephony.sampleRate).toBe(8_000);
    expect(telephony.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 180_000);
});
