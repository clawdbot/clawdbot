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

  it("infers language from a configured multilingual voice", () => {
    const config = provider.resolveConfig!({
      rawConfig: { voice: "Magpie-Multilingual.HI-IN.Sofia" },
      cfg: {} as never,
      timeoutMs: 30_000,
    });

    expect(config.language).toBe("hi-IN");
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

  it("advertises voices from the Magpie Multilingual catalog", () => {
    expect(provider.voices).toContain("Magpie-Multilingual.ZH-CN.HouZhen");
    expect(provider.voices).toContain("Magpie-Multilingual.HI-IN.Sofia");
    expect(provider.voices).toContain("Magpie-Multilingual.JA-JP.Isabela");
    expect(provider.voices).not.toContain("Magpie-Multilingual.HI-IN.Aarav");
    expect(provider.voices).not.toContain("Magpie-Multilingual.JA-JP.Hana");
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

  it("infers language from a Talk voice override", async () => {
    process.env.NVIDIA_API_KEY = "hosted-secret";

    await provider.synthesize({
      text: "hola",
      cfg: {},
      providerConfig: {},
      providerOverrides: { voice: "Magpie-Multilingual.ES-US.Diego" },
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(magpieSynthesizeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: "Magpie-Multilingual.ES-US.Diego",
        language: "es-US",
      }),
    );
  });

  it("uses shared credentials for the hosted Magpie /v1 base URL", async () => {
    delete process.env.NVIDIA_API_KEY;
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "profile-key" });
    const providerConfig = {
      baseUrl: "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1",
    };

    await provider.synthesize({
      text: "hello",
      cfg: {},
      providerConfig,
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(magpieSynthesizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "profile-key", baseUrl: providerConfig.baseUrl }),
    );
  });

  it("allows a keyless self-hosted Magpie endpoint", async () => {
    process.env.NVIDIA_API_KEY = "hosted-secret";
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "profile-secret" });
    const providerConfig = { baseUrl: "http://127.0.0.1:9000/v1" };

    expect(provider.isConfigured({ cfg: {}, providerConfig, timeoutMs: 5_000 })).toBe(true);
    await provider.synthesize({
      text: "hello",
      cfg: {},
      providerConfig,
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(magpieSynthesizeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        baseUrl: "http://127.0.0.1:9000/v1",
      }),
    );
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
  });
});
