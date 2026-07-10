// Xai tests cover tts plugin behavior.
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  isValidXaiTtsVoice,
  listXaiTtsVoices,
  XAI_BASE_URL,
  XAI_TTS_FALLBACK_VOICES,
  xaiTTS,
} from "./tts.js";

function createStreamingAudioResponse(params: {
  chunkCount: number;
  chunkSize: number;
  byte: number;
}): { response: Response; getReadCount: () => number } {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(new Uint8Array(params.chunkSize).fill(params.byte));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    }),
    getReadCount: () => reads,
  };
}

describe("xai tts", () => {
  const originalFetch = globalThis.fetch;
  let ssrfMock: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("isValidXaiTtsVoice", () => {
    it("accepts fallback, current, legacy, and custom voice ids", () => {
      for (const voice of XAI_TTS_FALLBACK_VOICES) {
        expect(isValidXaiTtsVoice(voice)).toBe(true);
      }
      for (const voice of ["altair", "ALTAIR", "una", "nlbqfwie"]) {
        expect(isValidXaiTtsVoice(voice)).toBe(true);
      }
    });

    it("rejects blank voice ids", () => {
      for (const voice of ["", "   ", "\n"]) {
        expect(isValidXaiTtsVoice(voice)).toBe(false);
      }
    });
  });

  describe("listXaiTtsVoices", () => {
    it("maps the authenticated catalog and sends the expected request", async () => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.7.9");
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              voices: [
                {
                  voice_id: "altair",
                  name: "Altair",
                  language: "en",
                  gender: "male",
                },
                { voice_id: "  celeste  ", name: " Celeste " },
                { voice_id: " " },
                { name: "missing id" },
                null,
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const voices = await listXaiTtsVoices({
        apiKey: "xai-key",
        baseUrl: "https://api.x.ai/v1/",
      });

      expect(voices).toEqual([
        { id: "altair", name: "Altair", locale: "en", gender: "male" },
        { id: "celeste", name: "Celeste", locale: undefined, gender: undefined },
      ]);
      const call = fetchMock.mock.calls[0];
      if (!call) {
        throw new Error("expected voice catalog request");
      }
      const [input, init] = call;
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(requestUrl).toBe("https://api.x.ai/v1/tts/voices");
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer xai-key");
      expect(headers.get("user-agent")).toBe("openclaw/2026.7.9");
      vi.unstubAllEnvs();
    });

    it("includes provider detail and request id for catalog errors", async () => {
      globalThis.fetch = vi.fn(
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
                "x-request-id": "req_voices",
              },
            },
          ),
      ) as unknown as typeof fetch;

      await expect(listXaiTtsVoices({ apiKey: "bad-key" })).rejects.toThrow(
        "xAI TTS voices API error (401): Invalid API key [type=invalid_request_error, code=invalid_api_key] [request_id=req_voices]",
      );
    });

    it("rejects malformed catalog payloads", async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ) as unknown as typeof fetch;

      await expect(listXaiTtsVoices({ apiKey: "xai-key" })).rejects.toThrow(
        "xAI TTS voices: malformed JSON response",
      );
    });

    it("caps catalog responses before parsing JSON", async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ voices: [], padding: "x".repeat(1024 * 1024) }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ) as unknown as typeof fetch;

      await expect(listXaiTtsVoices({ apiKey: "xai-key" })).rejects.toThrow(
        "xAI TTS voices: JSON response exceeds 1048576 bytes",
      );
    });
  });

  describe("xaiTTS diagnostics", () => {
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
        xaiTTS({
          text: "hello",
          apiKey: "bad-key",
          baseUrl: XAI_BASE_URL,
          voiceId: "eve",
          language: "en",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(
        "xAI TTS API error (401): Invalid API key [type=invalid_request_error, code=invalid_api_key] [request_id=req_123]",
      );
    });

    it("sends an openclaw User-Agent on xAI TTS requests", async () => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await xaiTTS({
        text: "hello",
        apiKey: "ok-key",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        language: "en",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });

      const init = fetchMock.mock.calls.at(0)?.[1];
      const headers = new Headers(init?.headers ?? {});
      expect(headers.get("user-agent")).toBe("openclaw/2026.3.22");
      expect(headers.get("authorization")).toBe("Bearer ok-key");
      vi.unstubAllEnvs();
    });

    it("caps streamed audio responses instead of buffering oversized TTS output", async () => {
      const streamed = createStreamingAudioResponse({
        chunkCount: 20,
        chunkSize: 1024,
        byte: 121,
      });
      const fetchMock = vi.fn(async () => streamed.response);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        xaiTTS({
          text: "hello",
          apiKey: "ok-key",
          baseUrl: XAI_BASE_URL,
          voiceId: "eve",
          language: "en",
          responseFormat: "mp3",
          timeoutMs: 5_000,
          maxBytes: 2048,
        }),
      ).rejects.toThrow("xAI TTS audio response exceeds 2048 bytes");

      expect(streamed.getReadCount()).toBeLessThan(20);
    });

    it("falls back to raw body text when the error body is non-JSON", async () => {
      const fetchMock = vi.fn(
        async () => new Response("temporary upstream outage", { status: 503 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        xaiTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: XAI_BASE_URL,
          voiceId: "eve",
          language: "en",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("xAI TTS API error (503): temporary upstream outage");
    });
  });
});
