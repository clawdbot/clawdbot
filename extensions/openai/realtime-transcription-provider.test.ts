import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

describe("buildOpenAIRealtimeTranscriptionProvider", () => {
  it("normalizes OpenAI config defaults", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            apiKey: "sk-test", // pragma: allowlist secret
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
    });
  });

  it("keeps provider-owned transcription settings configurable via raw provider config", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            language: "en",
            model: "gpt-4o-transcribe",
            prompt: "expect OpenClaw product names",
            silenceDurationMs: 900,
            vadThreshold: 0.45,
          },
        },
      },
    });

    expect(resolved).toEqual({
      language: "en",
      model: "gpt-4o-transcribe",
      prompt: "expect OpenClaw product names",
      silenceDurationMs: 900,
      vadThreshold: 0.45,
    });
  });

  it("accepts the legacy openai-realtime alias", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    expect(provider.aliases).toContain("openai-realtime");
  });
});
