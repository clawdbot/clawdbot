// Openai tests cover tts plugin behavior.
import {
  finalizeDebugProxyCapture,
  getDebugProxyCaptureStore,
  initializeDebugProxyCapture,
} from "openclaw/plugin-sdk/proxy-capture";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";
import { createStreamingErrorResponse } from "../test-support/streaming-error-response.js";
import {
  isValidOpenAIModel,
  isValidOpenAIVoice,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  openaiTTS,
} from "./tts.js";

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

const officialEndpointValidationCases = [
  {
    label: "voice validator",
    isAccepted: () => isValidOpenAIVoice("kokoro-custom-voice", "https://api.openai.com/v1/"),
  },
  {
    label: "model validator",
    isAccepted: () => isValidOpenAIModel("kokoro-custom-model", "https://api.openai.com/v1/"),
  },
];

function firstFetchCall(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error("expected fetch call");
  }
  return call;
}

function firstFetchInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  const init = firstFetchCall(fetchMock)[1];
  if (!init || typeof init !== "object") {
    throw new Error("expected fetch init");
  }
  return init as RequestInit;
}

describe("openai tts", () => {
  const originalFetch = globalThis.fetch;
  let openClawState: OpenClawTestState;

  beforeEach(async () => {
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openai-tts-capture-",
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await openClawState.cleanup();
  });

  // Install after local teardown so the proxy snapshot is restored before the
  // state helper removes its directory and restores the outer environment.
  const proxyReset = installDebugProxyTestResetHooks();

  describe("isValidOpenAIVoice", () => {
    it("accepts all valid OpenAI voices including newer additions", () => {
      for (const voice of OPENAI_TTS_VOICES) {
        expect(isValidOpenAIVoice(voice)).toBe(true);
      }
      for (const newerVoice of ["ballad", "cedar", "juniper", "marin", "verse"]) {
        expect(isValidOpenAIVoice(newerVoice), newerVoice).toBe(true);
      }
    });

    it("rejects invalid voice names", () => {
      expect(isValidOpenAIVoice("invalid")).toBe(false);
      expect(isValidOpenAIVoice("")).toBe(false);
      expect(isValidOpenAIVoice("ALLOY")).toBe(false);
      expect(isValidOpenAIVoice("alloy ")).toBe(false);
      expect(isValidOpenAIVoice(" alloy")).toBe(false);
    });
  });

  describe("isValidOpenAIModel", () => {
    it("matches the supported model set and rejects unsupported values", () => {
      expect(OPENAI_TTS_MODELS).toContain("gpt-4o-mini-tts");
      expect(OPENAI_TTS_MODELS).toContain("tts-1");
      expect(OPENAI_TTS_MODELS).toContain("tts-1-hd");
      expect(OPENAI_TTS_MODELS).toHaveLength(3);
      expect(Array.isArray(OPENAI_TTS_MODELS)).toBe(true);
      expect(OPENAI_TTS_MODELS.length).toBeGreaterThan(0);
      const cases = [
        { model: "gpt-4o-mini-tts", expected: true },
        { model: "tts-1", expected: true },
        { model: "tts-1-hd", expected: true },
        { model: "invalid", expected: false },
        { model: "", expected: false },
        { model: "gpt-4", expected: false },
      ] as const;
      for (const testCase of cases) {
        expect(isValidOpenAIModel(testCase.model), testCase.model).toBe(testCase.expected);
      }
    });
  });

  describe("official OpenAI TTS endpoint validation", () => {
    it.each(officialEndpointValidationCases)(
      "$label treats the default endpoint with trailing slash as the default endpoint",
      ({ isAccepted }) => {
        expect(isAccepted()).toBe(false);
      },
    );
  });

  describe("openaiTTS diagnostics", () => {
    it("adds OpenClaw attribution headers to native OpenAI speech requests", async () => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
      const fetchMock = vi.fn(
        async (_url: string | URL, _init?: RequestInit) =>
          new Response(Buffer.from("audio-bytes"), { status: 200 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await openaiTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });

      const url = firstFetchCall(fetchMock)[0];
      const init = firstFetchInit(fetchMock);
      const headers = init?.headers as Record<string, string> | undefined;
      expect(url).toBe("https://api.openai.com/v1/audio/speech");
      expect(headers?.originator).toBe("openclaw");
      expect(headers?.version).toBe("2026.3.22");
      expect(headers?.["User-Agent"]).toBe("openclaw/2026.3.22");
    });

    it("sends instructions to custom OpenAI-compatible endpoints", async () => {
      const fetchMock = vi.fn(
        async (_url: string | URL, _init?: RequestInit) =>
          new Response(Buffer.from("audio-bytes"), { status: 200 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await openaiTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://tts.example.com/v1",
        model: "tts-1",
        voice: "custom-voice",
        instructions: " Speak warmly ",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });

      const init = firstFetchInit(fetchMock);
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.instructions).toBe("Speak warmly");
      expect(body.model).toBe("tts-1");
      expect(body.voice).toBe("custom-voice");
    });

    it("merges sanitized extraBody fields into TTS requests", async () => {
      const fetchMock = vi.fn(
        async (_url: string | URL, _init?: RequestInit) =>
          new Response(Buffer.from("audio-bytes"), { status: 200 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const extraBody = JSON.parse(
        '{"lang":"e","speed":1.2,"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad"}',
      ) as Record<string, unknown>;

      await openaiTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://tts.example.com/v1",
        model: "tts-1",
        voice: "custom-voice",
        speed: 1,
        responseFormat: "mp3",
        extraBody,
        timeoutMs: 5_000,
      });

      const init = firstFetchInit(fetchMock);
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.model).toBe("tts-1");
      expect(body.input).toBe("hello");
      expect(body.voice).toBe("custom-voice");
      expect(body.response_format).toBe("mp3");
      expect(body.lang).toBe("e");
      expect(body.speed).toBe(1.2);
      expect(Object.hasOwn(body, "__proto__")).toBe(false);
      expect(Object.hasOwn(body, "constructor")).toBe(false);
      expect(Object.hasOwn(body, "prototype")).toBe(false);
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("omits instructions for unsupported models on the official OpenAI endpoint", async () => {
      const fetchMock = vi.fn(
        async (_url: string | URL, _init?: RequestInit) =>
          new Response(Buffer.from("audio-bytes"), { status: 200 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await openaiTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1/",
        model: "tts-1",
        voice: "alloy",
        instructions: "Speak warmly",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });

      const init = firstFetchInit(fetchMock);
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.instructions).toBeUndefined();
    });

    it("includes parsed provider detail and request id for JSON API errors", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Invalid API key",
                type: "invalid_request_error",
                code: "invalid_api_key",
              },
            }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "x-request-id": "req_123",
              },
            },
          ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "bad-key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(
        "OpenAI TTS API error (401): Invalid API key [type=invalid_request_error, code=invalid_api_key] [request_id=req_123]",
      );
    });

    it("falls back to raw body text when the error body is non-JSON", async () => {
      const fetchMock = vi.fn(
        async () => new Response("temporary upstream outage", { status: 503 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("OpenAI TTS API error (503): temporary upstream outage");
    });

    it.each([
      { name: "empty audio", body: new Uint8Array(), contentType: "audio/mpeg" },
      {
        name: "a successful JSON error",
        body: JSON.stringify({ error: "speech generation failed" }),
        contentType: "application/json",
      },
      {
        name: "a successful problem JSON error",
        body: JSON.stringify({ detail: "speech generation failed" }),
        contentType: "application/problem+json",
      },
      {
        name: "a successful HTML error",
        body: "<html>speech generation failed</html>",
        contentType: "text/html; charset=utf-8",
      },
      { name: "an image response", body: "image-bytes", contentType: "image/png" },
      { name: "a video response", body: "video-bytes", contentType: "video/mp4" },
      {
        name: "a second content type hidden in audio parameters",
        body: "audio-bytes",
        contentType: "audio/mpeg; charset=utf-8, text/html",
      },
      {
        name: "a missing audio type before a conflicting type",
        body: "audio-bytes",
        contentType: "; audio/mpeg, text/html",
      },
      { name: "a present empty audio content type", body: "audio-bytes", contentType: "" },
    ])("rejects $name instead of returning malformed audio", async ({ body, contentType }) => {
      globalThis.fetch = vi.fn(
        async () => new Response(body, { status: 200, headers: { "content-type": contentType } }),
      ) as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("OpenAI TTS API error: malformed audio response");
    });

    it.each([
      "audio/mpeg",
      "AUDIO/OGG; codecs=opus",
      "audio/aac",
      "audio/flac",
      "audio/wav",
      "audio/pcm",
      "application/octet-stream",
      undefined,
    ])("accepts nonempty audio with response content type %s", async (contentType) => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            Buffer.from("audio-bytes"),
            contentType ? { headers: { "content-type": contentType } } : undefined,
          ),
      ) as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual(Buffer.from("audio-bytes"));
    });

    it("cancels an unread invalid audio body before releasing its request", async () => {
      const cancel = vi.fn(async () => {});
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("still streaming"));
              },
              cancel,
            }),
            { headers: { "content-type": "image/png" } },
          ),
      ) as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("OpenAI TTS API error: malformed audio response");

      expect(cancel).toHaveBeenCalledOnce();
    });

    it("caps streamed audio responses instead of buffering oversized TTS output", async () => {
      const streamed = createStreamingErrorResponse({
        status: 200,
        chunkCount: 20,
        chunkSize: 1024,
        byte: 121,
      });
      const fetchMock = vi.fn(async () => streamed.response);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 5_000,
          maxBytes: 2048,
        }),
      ).rejects.toThrow("OpenAI TTS audio response exceeds 2048 bytes");

      expect(streamed.getReadCount()).toBeLessThan(20);
    });

    it("caps streamed non-JSON error reads instead of consuming full response bodies", async () => {
      const streamed = createStreamingErrorResponse({
        status: 503,
        chunkCount: 200,
        chunkSize: 1024,
        byte: 120,
      });
      const fetchMock = vi.fn(async () => streamed.response);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("OpenAI TTS API error (503)");

      expect(streamed.getReadCount()).toBeLessThan(200);
    });

    it("does not block on an endless malformed audio stream cloned for debug capture", async () => {
      proxyReset.captureProxyEnv();
      process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
      process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "tts-malformed-capture";
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                controller.enqueue(new TextEncoder().encode("endless malformed response"));
              },
            }),
            { headers: { "content-type": "image/png" } },
          ),
      ) as unknown as typeof fetch;
      initializeDebugProxyCapture("test");

      try {
        await expect(
          Promise.race([
            openaiTTS({
              text: "hello",
              apiKey: "test-key",
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-4o-mini-tts",
              voice: "alloy",
              responseFormat: "mp3",
              timeoutMs: 5_000,
            }),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error("capture cancellation stalled")), 250);
            }),
          ]),
        ).rejects.toThrow("OpenAI TTS API error: malformed audio response");
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        streamController?.close();
        try {
          await vi.waitFor(() => {
            const events = getDebugProxyCaptureStore().getSessionEvents(
              "tts-malformed-capture",
              10,
            );
            expect(events.map((event) => event.kind).toSorted()).toEqual(["request", "response"]);
          });
        } finally {
          finalizeDebugProxyCapture();
        }
      }
    });

    it("records TTS exchanges in debug proxy capture mode", async () => {
      proxyReset.captureProxyEnv();
      process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
      process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "tts-session";

      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), { status: 200 }),
        ) as unknown as typeof globalThis.fetch;

      const store = getDebugProxyCaptureStore();
      store.upsertSession({
        id: "tts-session",
        startedAt: Date.now(),
        mode: "test",
        sourceScope: "openclaw",
        sourceProcess: "openclaw",
      });

      await openaiTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });

      await vi.waitFor(() => {
        const events = store.getSessionEvents("tts-session", 10);
        expect(
          events.some((event) => event.kind === "request" && event.host === "api.openai.com"),
        ).toBe(true);
        expect(
          events.some((event) => event.kind === "response" && event.host === "api.openai.com"),
        ).toBe(true);
      });
    });

    it("does not double-capture TTS exchanges when the global fetch patch is installed", async () => {
      proxyReset.captureProxyEnv();
      process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
      process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "tts-patched-session";

      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), { status: 200 }),
        ) as unknown as typeof globalThis.fetch;

      initializeDebugProxyCapture("test");

      await openaiTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });

      const store = getDebugProxyCaptureStore();
      let events: Array<Record<string, unknown>> = [];
      try {
        await vi.waitFor(() => {
          events = store
            .getSessionEvents("tts-patched-session", 10)
            .filter((event) => event.host === "api.openai.com");
          expect(events).toHaveLength(2);
        });
        const kinds = events.map((event) => String(event.kind)).toSorted();
        expect(kinds).toEqual(["request", "response"]);
      } finally {
        finalizeDebugProxyCapture();
      }
    });
  });
});
