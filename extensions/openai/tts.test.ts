import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  finalizeDebugProxyCapture,
  getDebugProxyCaptureStore,
  initializeDebugProxyCapture,
} from "openclaw/plugin-sdk/proxy-capture";
import { describe, expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";
import { createStreamingErrorResponse } from "../test-support/streaming-error-response.js";
import {
  isValidOpenAIModel,
  isValidOpenAIVoice,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  openaiTTS,
  resolveOpenAITtsInstructions,
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

describe("openai tts", () => {
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

    it("treats the default endpoint with trailing slash as the default endpoint", () => {
      expect(isValidOpenAIVoice("kokoro-custom-voice", "https://api.openai.com/v1/")).toBe(false);
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

    it("treats the default endpoint with trailing slash as the default endpoint", () => {
      expect(isValidOpenAIModel("kokoro-custom-model", "https://api.openai.com/v1/")).toBe(false);
    });
  });

  describe("resolveOpenAITtsInstructions", () => {
    it("keeps instructions only for gpt-4o-mini-tts variants", () => {
      expect(resolveOpenAITtsInstructions("gpt-4o-mini-tts", " Speak warmly ")).toBe(
        "Speak warmly",
      );
      expect(resolveOpenAITtsInstructions("gpt-4o-mini-tts-2025-12-15", "Speak warmly")).toBe(
        "Speak warmly",
      );
      expect(resolveOpenAITtsInstructions("tts-1", "Speak warmly")).toBeUndefined();
      expect(resolveOpenAITtsInstructions("tts-1-hd", "Speak warmly")).toBeUndefined();
      expect(resolveOpenAITtsInstructions("gpt-4o-mini-tts", "   ")).toBeUndefined();
    });

    it("preserves instructions for custom OpenAI-compatible TTS endpoints", () => {
      expect(
        resolveOpenAITtsInstructions("tts-1", " Speak warmly ", "https://tts.example.com/v1"),
      ).toBe("Speak warmly");
      expect(
        resolveOpenAITtsInstructions("tts-1", " Speak warmly ", "https://api.openai.com/v1/"),
      ).toBeUndefined();
      expect(
        resolveOpenAITtsInstructions("tts-1", "   ", "https://tts.example.com/v1"),
      ).toBeUndefined();
    });
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

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.openai.com/v1/audio/speech",
        expect.objectContaining({
          headers: expect.objectContaining({
            originator: "openclaw",
            version: "2026.3.22",
            "User-Agent": "openclaw/2026.3.22",
          }),
        }),
      );
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

      const [, init] = fetchMock.mock.calls[0] ?? [];
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

      const [, init] = fetchMock.mock.calls[0] ?? [];
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "tts-1",
        input: "hello",
        voice: "custom-voice",
        response_format: "mp3",
        lang: "e",
        speed: 1.2,
      });
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

      const [, init] = fetchMock.mock.calls[0] ?? [];
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

    it("records TTS exchanges in debug proxy capture mode", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "openai-tts-capture-"));
      proxyReset.captureProxyEnv();
      process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
      process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = path.join(tempDir, "capture.sqlite");
      process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = path.join(tempDir, "blobs");
      process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "tts-session";

      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), { status: 200 }),
        ) as unknown as typeof globalThis.fetch;

      const store = getDebugProxyCaptureStore(
        process.env.OPENCLAW_DEBUG_PROXY_DB_PATH,
        process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR,
      );
      store.upsertSession({
        id: "tts-session",
        startedAt: Date.now(),
        mode: "test",
        sourceScope: "openclaw",
        sourceProcess: "openclaw",
        dbPath: process.env.OPENCLAW_DEBUG_PROXY_DB_PATH,
        blobDir: process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR,
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
      await new Promise((resolve) => setTimeout(resolve, 0));

      const events = store.getSessionEvents("tts-session", 10);
      expect(
        events.some((event) => event.kind === "request" && event.host === "api.openai.com"),
      ).toBe(true);
      expect(
        events.some((event) => event.kind === "response" && event.host === "api.openai.com"),
      ).toBe(true);
    });

    it("does not double-capture TTS exchanges when the global fetch patch is installed", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "openai-tts-patched-capture-"));
      proxyReset.captureProxyEnv();
      process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
      process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = path.join(tempDir, "capture.sqlite");
      process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = path.join(tempDir, "blobs");
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
      await new Promise((resolve) => setTimeout(resolve, 0));
      finalizeDebugProxyCapture();

      const store = getDebugProxyCaptureStore(
        process.env.OPENCLAW_DEBUG_PROXY_DB_PATH,
        process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR,
      );
      const events = store
        .getSessionEvents("tts-patched-session", 10)
        .filter((event) => event.host === "api.openai.com");
      expect(events).toHaveLength(2);
      const kinds = events.map((event) => String(event.kind)).toSorted();
      expect(kinds).toEqual(["request", "response"]);
      store.close();
    });
  });
});
