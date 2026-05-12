import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async ({
    url,
    init,
  }: {
    url: string;
    init?: RequestInit;
  }): Promise<{ response: Response; release: () => Promise<void> }> => ({
    response: await globalThis.fetch(url, init),
    release: vi.fn(async () => {}),
  }),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

function isSpeechRequestBody(value: unknown): value is {
  [key: string]: unknown;
  model?: string;
  voice?: string;
  speed?: number;
  response_format?: string;
} {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequestBody(init: RequestInit | undefined): {
  [key: string]: unknown;
  model?: string;
  voice?: string;
  speed?: number;
  response_format?: string;
} {
  if (typeof init?.body !== "string") {
    throw new Error("expected string request body");
  }
  const body: unknown = JSON.parse(init.body);
  if (!isSpeechRequestBody(body)) {
    throw new Error("expected OpenAI speech request body");
  }
  return body;
}

function mockSpeechFetchExpectingFormat(responseFormat: string) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = parseRequestBody(init);
    expect(body.response_format).toBe(responseFormat);
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
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
            extraBody: {
              lang: "en-US",
            },
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
      extraBody: {
        lang: "en-US",
      },
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

    const resolvedConfig = provider.resolveTalkConfig?.({
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
    });
    expect(resolvedConfig?.apiKey).toBe("sk-talk");
    expect(resolvedConfig?.responseFormat).toBe("wav");
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

  it("maps persona prompt fields to instructions when instructions are unset", async () => {
    const provider = buildOpenAISpeechProvider();

    const prepared = await provider.prepareSynthesis?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "sk-test",
        model: "gpt-4o-mini-tts",
        voice: "cedar",
      },
      persona: {
        id: "alfred",
        label: "Alfred",
        prompt: {
          profile: "A brilliant British butler.",
          scene: "A quiet late-night study.",
          sampleContext: "The speaker is answering a trusted operator.",
          style: "Refined and lightly amused.",
          accent: "British English.",
          pacing: "Measured.",
          constraints: ["Do not read configuration values aloud."],
        },
      },
      target: "audio-file",
      timeoutMs: 1_000,
    });

    expect(prepared?.providerConfig?.instructions).toContain("Persona: Alfred");
    expect(prepared?.providerConfig?.instructions).toContain(
      "Constraint: Do not read configuration values aloud.",
    );
  });

  it("uses wav for Groq-compatible OpenAI TTS endpoints", async () => {
    const provider = buildOpenAISpeechProvider();
    mockSpeechFetchExpectingFormat("wav");

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

  it("applies provider overrides to telephony synthesis", async () => {
    const provider = buildOpenAISpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body.model).toBe("tts-1");
      expect(body.voice).toBe("nova");
      expect(body.speed).toBe(1.25);
      expect(body.response_format).toBe("pcm");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "sk-test",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        speed: 1,
      },
      providerOverrides: {
        model: "tts-1",
        voice: "nova",
        speed: 1.25,
      },
      timeoutMs: 1_000,
    });

    expect(result?.outputFormat).toBe("pcm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors explicit responseFormat overrides and clears voice-note compatibility when not opus", async () => {
    const provider = buildOpenAISpeechProvider();
    mockSpeechFetchExpectingFormat("wav");

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

  it("passes extra_body config through to OpenAI-compatible speech requests", async () => {
    const provider = buildOpenAISpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body.model).toBe("custom-tts");
      expect(body.voice).toBe("custom-voice");
      expect(body.lang).toBe("en-US");
      expect(body.response_format).toBe("mp3");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesize({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "sk-test",
        baseUrl: "https://proxy.example.com/openai/v1",
        model: "custom-tts",
        voice: "custom-voice",
        responseFormat: "mp3",
        extra_body: {
          lang: "en-US",
        },
      },
      target: "audio-file",
      timeoutMs: 1_000,
    });

    expect(result.outputFormat).toBe("mp3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
