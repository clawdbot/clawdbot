import { describe, expect, it, vi } from "vitest";
import {
  deepinfraMediaUnderstandingProvider,
  transcribeDeepInfraAudio,
} from "./media-understanding-provider.js";

const { transcribeOpenAiCompatibleAudioMock } = vi.hoisted(() => ({
  transcribeOpenAiCompatibleAudioMock: vi.fn(async () => ({ text: "hello", model: "whisper" })),
}));

vi.mock("openclaw/plugin-sdk/media-understanding", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-understanding")>(
    "openclaw/plugin-sdk/media-understanding",
  );
  return {
    ...actual,
    transcribeOpenAiCompatibleAudio: transcribeOpenAiCompatibleAudioMock,
  };
});

describe("deepinfra media understanding provider", () => {
  it("declares image and audio defaults", () => {
    expect(deepinfraMediaUnderstandingProvider).toMatchObject({
      id: "deepinfra",
      capabilities: ["image", "audio"],
      defaultModels: {
        image: "moonshotai/Kimi-K2.5",
        audio: "openai/whisper-large-v3-turbo",
      },
    });
    expect(deepinfraMediaUnderstandingProvider.describeImage).toBeTypeOf("function");
    expect(deepinfraMediaUnderstandingProvider.describeImages).toBeTypeOf("function");
  });

  it("routes audio transcription through the OpenAI-compatible DeepInfra endpoint", async () => {
    const result = await transcribeDeepInfraAudio({
      buffer: Buffer.from("audio"),
      fileName: "clip.mp3",
      apiKey: "deepinfra-key",
      timeoutMs: 30_000,
    });

    expect(result.text).toBe("hello");
    expect(transcribeOpenAiCompatibleAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepinfra",
        defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
        defaultModel: "openai/whisper-large-v3-turbo",
      }),
    );
  });
});
