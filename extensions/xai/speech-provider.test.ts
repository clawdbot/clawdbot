import { describe, expect, it, vi } from "vitest";
import { buildXaiSpeechProvider } from "./speech-provider.js";

const { xaiTTSMock } = vi.hoisted(() => ({
  xaiTTSMock: vi.fn(async () => Buffer.from("audio-bytes")),
}));

vi.mock("./tts.js", () => ({
  XAI_BASE_URL: "https://api.x.ai/v1",
  XAI_TTS_VOICES: ["eve", "ara", "rex", "sal", "leo", "una"],
  isValidXaiTtsVoice: (voice: string) => ["eve", "ara", "rex", "sal", "leo", "una"].includes(voice),
  normalizeXaiLanguageCode: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined,
  normalizeXaiTtsBaseUrl: (baseUrl?: string) =>
    baseUrl?.trim().replace(/\/+$/, "") || "https://api.x.ai/v1",
  xaiTTS: xaiTTSMock,
}));

describe("xai speech provider", () => {
  it("synthesizes mp3 audio and does not claim native voice-note compatibility", async () => {
    const provider = buildXaiSpeechProvider();
    const result = await provider.synthesize({
      text: "hello",
      cfg: {},
      providerConfig: {
        apiKey: "xai-key",
        voiceId: "eve",
      },
      target: "voice-note",
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
    expect(result.audioBuffer.byteLength).toBeGreaterThan(0);
    expect(xaiTTSMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        apiKey: "xai-key",
        baseUrl: "https://api.x.ai/v1",
        voiceId: "eve",
        responseFormat: "mp3",
      }),
    );
  });

  it("honors configured response formats", async () => {
    const provider = buildXaiSpeechProvider();
    const result = await provider.synthesize({
      text: "hello",
      cfg: {},
      providerConfig: {
        apiKey: "xai-key",
        responseFormat: "wav",
      },
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(xaiTTSMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseFormat: "wav",
      }),
    );
  });
});
