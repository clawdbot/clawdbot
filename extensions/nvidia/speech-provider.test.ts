import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNvidiaSpeechProvider } from "./speech-provider.js";

const { isProviderAuthProfileConfiguredMock, magpieSynthesizeMock, resolveApiKeyForProviderMock } =
  vi.hoisted(() => ({
    isProviderAuthProfileConfiguredMock: vi.fn(() => false),
    magpieSynthesizeMock: vi.fn(async () => Buffer.from("wav-audio")),
    resolveApiKeyForProviderMock: vi.fn(
      async (): Promise<{ apiKey: string | undefined }> => ({ apiKey: undefined }),
    ),
  }));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: isProviderAuthProfileConfiguredMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("./nvidia-speech-http.runtime.js", () => ({
  magpieSynthesize: magpieSynthesizeMock,
}));

describe("NVIDIA Magpie speech provider", () => {
  const provider = buildNvidiaSpeechProvider();
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    isProviderAuthProfileConfiguredMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReturnValue(false);
    magpieSynthesizeMock.mockClear();
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
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

  it("forwards multilingual Talk voice and language overrides", () => {
    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: {},
        params: {
          voiceId: "Magpie-Multilingual.ES-US.Diego",
          language: "es-US",
        },
      }),
    ).toEqual({
      voice: "Magpie-Multilingual.ES-US.Diego",
      language: "es-US",
    });
  });

  it("reports configured when a shared NVIDIA auth profile exists", () => {
    delete process.env.NVIDIA_API_KEY;
    isProviderAuthProfileConfiguredMock.mockReturnValue(true);

    expect(provider.isConfigured({ cfg: {}, providerConfig: {}, timeoutMs: 5_000 })).toBe(true);
    expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith({
      provider: "nvidia",
      cfg: {},
    });
  });

  it("uses a shared NVIDIA auth profile for synthesis", async () => {
    delete process.env.NVIDIA_API_KEY;
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "profile-key" });
    const cfg = { agents: { defaults: {} } };

    const result = await provider.synthesize({
      text: "hello",
      cfg,
      providerConfig: {},
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({ provider: "nvidia", cfg });
    expect(magpieSynthesizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "profile-key", text: "hello" }),
    );
    expect(result.outputFormat).toBe("wav");
    expect(result.voiceCompatible).toBe(false);
  });
});
