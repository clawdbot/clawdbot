import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";

const INWORLD_API_KEY = process.env.INWORLD_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled() && INWORLD_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

const registerInworldPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "inworld",
    name: "Inworld",
  });

describeLive("inworld plugin live", () => {
  it("lists voices through the registered speech provider", async () => {
    const { speechProviders } = await registerInworldPlugin();
    const provider = requireRegisteredProvider(speechProviders, "inworld");

    const voices = await provider.listVoices?.({
      apiKey: INWORLD_API_KEY,
    });

    expect(voices?.length).toBeGreaterThan(0);
    expect(voices).toEqual(expect.arrayContaining([expect.objectContaining({ id: "Sarah" })]));
  }, 120_000);

  it("synthesizes MP3, native voice-note Ogg/Opus, and telephony PCM", async () => {
    const { speechProviders } = await registerInworldPlugin();
    const provider = requireRegisteredProvider(speechProviders, "inworld");
    const providerConfig = {
      apiKey: INWORLD_API_KEY,
      voiceId: "Sarah",
      modelId: "inworld-tts-1.5-max",
    };

    const audioFile = await provider.synthesize({
      text: "OpenClaw Inworld text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.voiceCompatible).toBe(false);
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
    expect(audioFile.audioBuffer.subarray(0, 4).toString("ascii")).not.toBe("RIFF");

    const voiceNote = await provider.synthesize({
      text: "OpenClaw Inworld voice note integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      target: "voice-note",
      timeoutMs: 90_000,
    });

    expect(voiceNote.outputFormat).toBe("ogg_opus");
    expect(voiceNote.fileExtension).toBe(".ogg");
    expect(voiceNote.voiceCompatible).toBe(true);
    expect(voiceNote.audioBuffer.byteLength).toBeGreaterThan(128);
    expect(voiceNote.audioBuffer.subarray(0, 4).toString("ascii")).toBe("OggS");

    const telephony = await provider.synthesizeTelephony?.({
      text: "OpenClaw Inworld telephony check OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      timeoutMs: 90_000,
    });
    if (!telephony) {
      throw new Error("Inworld telephony synthesis did not return audio");
    }
    expect(telephony.outputFormat).toBe("pcm");
    expect(telephony.sampleRate).toBe(22_050);
    expect(telephony.audioBuffer.byteLength).toBeGreaterThan(512);
    expect(telephony.audioBuffer.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
  }, 180_000);
});
