import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

describe("buildOpenAIRealtimeVoiceProvider", () => {
  it("normalizes provider-owned voice settings from raw provider config", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            model: "gpt-realtime",
            voice: "verse",
            temperature: 0.6,
            silenceDurationMs: 850,
            vadThreshold: 0.35,
          },
        },
      },
    });

    expect(resolved).toEqual({
      model: "gpt-realtime",
      voice: "verse",
      temperature: 0.6,
      silenceDurationMs: 850,
      vadThreshold: 0.35,
    });
  });
});
