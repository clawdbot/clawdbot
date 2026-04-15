import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

function isSpeechRequestBody(value: unknown): value is { response_format?: string } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequestBody(init: RequestInit | undefined): { response_format?: string } {
  if (typeof init?.body !== "string") {
    throw new Error("expected string request body");
  }
  const body: unknown = JSON.parse(init.body);
  if (!isSpeechRequestBody(body)) {
    throw new Error("expected OpenAI speech request body");
  }
  return body;
}

describe("buildOpenAISpeechProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes provider-owned speech config from raw provider config", () => {
    const provider = buildOpenAISpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          openai: {
            apiKey: "sk-test",
            baseUrl: "https://example.com/v1/",
            model: "tts-1",
            voice: "alloy",
            speed: 1.25,
            instructions: " Speak warmly ",
            responseFormat: " WAV ",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "tts-1",
      voice: "alloy",
      speed: 1.25,
      instructions: "Speak warmly",
      responseFormat: "wav",
    });
  });

  it("parses OpenAI directive tokens against the resolved base url", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.parseDirectiveToken?.({
        key: "voice",
        value: "alloy",
        policy: {
          allowVoice: true,
          allowModelId: true,
        },
        providerConfig: {
          baseUrl: "https://api.openai.com/v1/",
        },
      } as never),
    ).toEqual({
      handled: true,
      overrides: { voice: "alloy" },
    });

    expect(
      provider.parseDirectiveToken?.({
        key: "model",
        value: "kokoro-custom-model",
        policy: {
          allowVoice: true,
          allowModelId: true,
        },
        providerConfig: {
          baseUrl: "https://api.openai.com/v1/",
        },
      } as never),
    ).toEqual({
      handled: false,
    });
  });

  it("preserves talk responseFormat overrides", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.resolveTalkConfig?.({
        cfg: {} as never,
        timeoutMs: 30_000,
        baseTtsConfig: {
          providers: {
            openai: {
              apiKey: "sk-base",
              responseFormat: "mp3",
            },
          },
        },
        talkProviderConfig: {
          apiKey: "sk-talk",
          responseFormat: " WAV ",
        },
      }),
    ).toMatchObject({
      apiKey: "sk-talk",
      responseFormat: "wav",
    });
  });

  it("maps Talk speak params onto OpenAI speech overrides", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: {},
        params: {
          text: "Hello from talk mode.",
          voiceId: "nova",
          modelId: "tts-1",
          speed: 218 / 175,
        },
      }),
    ).toEqual({
      voice: "nova",
      model: "tts-1",
      speed: 218 / 175,
    });
  });

  it("uses wav for Groq-compatible OpenAI TTS endpoints", async () => {
    const provider = buildOpenAISpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body.response_format).toBe("wav");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesize({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "sk-test",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "canopylabs/orpheus-v1-english",
        voice: "daniel",
      },
      target: "audio-file",
      timeoutMs: 1_000,
    });

    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
  });

  it("honors explicit responseFormat overrides and clears voice-note compatibility when not opus", async () => {
    const provider = buildOpenAISpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body.response_format).toBe("wav");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesize({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "sk-test",
        baseUrl: "https://proxy.example.com/openai/v1",
        model: "canopylabs/orpheus-v1-english",
        voice: "daniel",
        responseFormat: "wav",
      },
      target: "voice-note",
      timeoutMs: 1_000,
    });

    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
  });
});
