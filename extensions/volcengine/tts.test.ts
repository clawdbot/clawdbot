import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildVolcengineSpeechProvider } from "./speech-provider.js";
import { volcengineTTS } from "./tts.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

function requireFirstGuardedFetchCall(): unknown {
  const [call] = fetchWithSsrFGuardMock.mock.calls;
  if (!call) {
    throw new Error("expected Volcengine guarded fetch call");
  }
  return call[0];
}

function makeProviderConfig(overrides?: Record<string, unknown>) {
  return {
    apiKey: "test-api-key",
    voice: "en_female_anna_mars_bigtts",
    ...overrides,
  };
}

function makeLegacyProviderConfig(overrides?: Record<string, unknown>) {
  return {
    appId: "test-app-id",
    token: "test-token",
    voice: "zh_female_xiaohe_uranus_bigtts",
    cluster: "volcano_tts",
    ...overrides,
  };
}

function clearTtsEnv() {
  delete process.env.BYTEPLUS_API_KEY;
  delete process.env.BYTEPLUS_SEED_SPEECH_API_KEY;
  delete process.env.VOLCENGINE_TTS_API_KEY;
  delete process.env.VOLCENGINE_TTS_APPID;
  delete process.env.VOLCENGINE_TTS_TOKEN;
}

function restoreOptionalEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("Volcengine speech provider", () => {
  const provider = buildVolcengineSpeechProvider();

  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("has correct id, label, and aliases", () => {
    expect(provider.id).toBe("volcengine");
    expect(provider.label).toBe("Volcengine");
    expect(provider.aliases).toContain("bytedance");
    expect(provider.aliases).toContain("doubao");
  });

  it("reports configured when an API key is present in providerConfig", () => {
    expect(provider.isConfigured({ providerConfig: makeProviderConfig(), timeoutMs: 30000 })).toBe(
      true,
    );
  });

  it("reports configured for legacy appId and token in providerConfig", () => {
    expect(
      provider.isConfigured({ providerConfig: makeLegacyProviderConfig(), timeoutMs: 30000 }),
    ).toBe(true);
  });

  it("reports not configured when credentials are missing", () => {
    const oldBytePlusKey = process.env.BYTEPLUS_API_KEY;
    const oldSeedKey = process.env.BYTEPLUS_SEED_SPEECH_API_KEY;
    const oldApiKey = process.env.VOLCENGINE_TTS_API_KEY;
    const oldAppId = process.env.VOLCENGINE_TTS_APPID;
    const oldToken = process.env.VOLCENGINE_TTS_TOKEN;
    clearTtsEnv();
    try {
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30000 })).toBe(false);
    } finally {
      restoreOptionalEnv("BYTEPLUS_API_KEY", oldBytePlusKey);
      restoreOptionalEnv("BYTEPLUS_SEED_SPEECH_API_KEY", oldSeedKey);
      restoreOptionalEnv("VOLCENGINE_TTS_API_KEY", oldApiKey);
      restoreOptionalEnv("VOLCENGINE_TTS_APPID", oldAppId);
      restoreOptionalEnv("VOLCENGINE_TTS_TOKEN", oldToken);
    }
  });

  it("falls back to env vars for credentials", () => {
    const oldBytePlusKey = process.env.BYTEPLUS_API_KEY;
    const oldSeedKey = process.env.BYTEPLUS_SEED_SPEECH_API_KEY;
    const oldApiKey = process.env.VOLCENGINE_TTS_API_KEY;
    const oldAppId = process.env.VOLCENGINE_TTS_APPID;
    const oldToken = process.env.VOLCENGINE_TTS_TOKEN;
    clearTtsEnv();
    process.env.BYTEPLUS_SEED_SPEECH_API_KEY = "env-api-key";
    try {
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30000 })).toBe(true);
    } finally {
      restoreOptionalEnv("BYTEPLUS_API_KEY", oldBytePlusKey);
      restoreOptionalEnv("BYTEPLUS_SEED_SPEECH_API_KEY", oldSeedKey);
      restoreOptionalEnv("VOLCENGINE_TTS_API_KEY", oldApiKey);
      restoreOptionalEnv("VOLCENGINE_TTS_APPID", oldAppId);
      restoreOptionalEnv("VOLCENGINE_TTS_TOKEN", oldToken);
    }
  });

  it("lists voices with locale and gender", async () => {
    const listVoices = provider.listVoices;
    if (!listVoices) {
      throw new Error("Expected Volcengine provider listVoices");
    }
    const voices = await listVoices({});
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toEqual({
      id: "en_female_anna_mars_bigtts",
      name: "anna",
      locale: "en-US",
      gender: "female",
    });
  });

  it("sends the documented Seed Speech API key payload and returns voice-note Opus metadata", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          code: 0,
          data: Buffer.from("voice-audio").toString("base64"),
        }),
      ),
      release,
    });

    const result = await provider.synthesize({
      text: "hello",
      cfg: {},
      providerConfig: makeProviderConfig({ emotion: "happy", speedRatio: 1.2 }),
      target: "voice-note",
      providerOverrides: { voice: "zh_male_aojiao_mars_bigtts", speedRatio: 0.9 },
      timeoutMs: 1234,
    });

    expect(result.audioBuffer.toString()).toBe("voice-audio");
    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".opus");
    expect(result.voiceCompatible).toBe(true);

    const call = requireFirstGuardedFetchCall();
    expect(call).toEqual({
      url: "https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/unidirectional",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Connection: "keep-alive",
          "X-Api-Key": "test-api-key",
          "X-Api-Resource-Id": "seed-tts-1.0",
          "X-Api-App-Key": "aGjiRDfUWi",
        },
        body: JSON.stringify({
          user: { uid: "openclaw" },
          req_params: {
            text: "hello",
            speaker: "zh_male_aojiao_mars_bigtts",
            audio_params: {
              format: "ogg_opus",
              sample_rate: 24000,
            },
            speed_ratio: 0.9,
            emotion: "happy",
          },
        }),
      },
      timeoutMs: 1234,
      policy: { hostnameAllowlist: ["voice.ap-southeast-1.bytepluses.com"] },
      auditContext: "volcengine.tts",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("volcengineTTS", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("joins streamed Seed Speech audio frames", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        [
          JSON.stringify({ code: 0, message: "" }),
          JSON.stringify({ code: 0, data: Buffer.from("audio-1").toString("base64") }),
          JSON.stringify({ code: 0, data: Buffer.from("audio-2").toString("base64") }),
          JSON.stringify({ code: 20000000, message: "ok", data: null }),
        ].join("\n"),
      ),
      release,
    });

    const audio = await volcengineTTS({
      text: "hello",
      apiKey: "secret-api-key",
      voice: "zh_female_xiaohe_uranus_bigtts",
      encoding: "mp3",
      timeoutMs: 1000,
    });

    expect(audio.toString()).toBe("audio-1audio-2");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports Seed Speech provider errors without exposing credentials", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({ header: { code: 45000000, message: "speaker permission denied" } }),
        { status: 403 },
      ),
      release,
    });

    let error: unknown;
    try {
      await volcengineTTS({
        text: "hello",
        apiKey: "secret-api-key",
        timeoutMs: 1000,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "BytePlus Seed Speech TTS error 45000000: speaker permission denied",
    );
    expect((error as Error).message).not.toContain("secret-api-key");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports provider errors without exposing credentials", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ code: 3001, message: "load grant failed" }), {
        status: 401,
      }),
      release,
    });

    let error: unknown;
    try {
      await volcengineTTS({
        text: "hello",
        appId: "app-id",
        token: "secret-token",
        timeoutMs: 1000,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Volcengine TTS error 3001: load grant failed");
    expect((error as Error).message).not.toContain("secret-token");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
