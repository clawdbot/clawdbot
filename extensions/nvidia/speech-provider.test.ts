import { afterEach, describe, expect, it } from "vitest";
import { buildNvidiaSpeechProvider } from "./speech-provider.js";

describe("NVIDIA Magpie speech provider", () => {
  const provider = buildNvidiaSpeechProvider();
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("defaults to Magpie multilingual over HTTP", () => {
    delete process.env.NVIDIA_TTS_BASE_URL;
    const config = provider.resolveConfig!({
      rawConfig: {},
      cfg: {} as never,
      timeoutMs: 30_000,
    });

    expect(config.model).toBe("magpie-tts-multilingual");
    expect(config.voice).toBe("Magpie-Multilingual.EN-US.Aria");
    expect(config.baseUrl).toContain("invocation.api.nvcf.nvidia.com");
  });

  it("accepts custom pronunciation and model configuration", () => {
    const config = provider.resolveConfig!({
      rawConfig: {
        providers: {
          nvidia: {
            customDictionary: "Nemotron  pronunciation",
            customConfiguration: "key:value",
          },
        },
      },
      cfg: {} as never,
      timeoutMs: 30_000,
    });

    expect(config.customDictionary).toBe("Nemotron  pronunciation");
    expect(config.customConfiguration).toBe("key:value");
  });
});
