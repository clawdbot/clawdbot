import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { isValidXaiTtsVoice, XAI_BASE_URL, XAI_TTS_VOICES, xaiTTS } from "./tts.js";

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
    it("accepts all valid voices", () => {
      for (const voice of XAI_TTS_VOICES) {
        expect(isValidXaiTtsVoice(voice)).toBe(true);
      }
    });

    it("rejects invalid voice names", () => {
      expect(isValidXaiTtsVoice("invalid")).toBe(false);
      expect(isValidXaiTtsVoice("")).toBe(false);
      expect(isValidXaiTtsVoice("ALLOY")).toBe(false);
      expect(isValidXaiTtsVoice("alloy ")).toBe(false);
      expect(isValidXaiTtsVoice(" alloy")).toBe(false);
    });

    it("treats custom endpoints as permissive", () => {
      expect(isValidXaiTtsVoice("grok-voice-custom", "https://custom.api.x.ai/v1")).toBe(true);
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
