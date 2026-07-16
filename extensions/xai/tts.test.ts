// Xai tests cover tts plugin behavior.
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  isValidXaiTtsVoice,
  listXaiTtsVoices,
  XAI_BASE_URL,
  XAI_TTS_FALLBACK_VOICES,
  xaiTTS,
  xaiTTSStream,
} from "./tts.js";

const { FakeWebSocket } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readonly headers?: Record<string, string>;
    readonly maxPayload?: number;
    readonly url?: string;
    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];

    constructor(url?: string, options?: { headers?: Record<string, string>; maxPayload?: number }) {
      this.url = url;
      this.headers = options?.headers;
      this.maxPayload = options?.maxPayload;
      MockWebSocket.instances.push(this);
    }

    once(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    terminate(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

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
    FakeWebSocket.instances = [];
    vi.useRealTimers();
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

  describe("xaiTTSStream", () => {
    it("streams decoded audio chunks without buffering the full body", async () => {
      const resultPromise = xaiTTSStream({
        text: "hello",
        apiKey: "dummy",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        language: "en",
        responseFormat: "mp3",
        speed: 1.1,
        timeoutMs: 5_000,
        maxBytes: 3_000,
      });
      const ws = FakeWebSocket.instances.at(0);
      const wsUrl = new URL(ws?.url ?? "");
      expect(wsUrl.protocol).toBe("wss:");
      expect(wsUrl.pathname).toBe("/v1/tts");
      expect(wsUrl.searchParams.get("voice")).toBe("eve");
      expect(wsUrl.searchParams.get("language")).toBe("en");
      expect(wsUrl.searchParams.get("codec")).toBe("mp3");
      expect(wsUrl.searchParams.get("speed")).toBe("1.1");
      expect(ws?.headers?.Authorization).toBe(["Bearer", "dummy"].join(" "));
      expect(ws?.maxPayload).toBe(5_024);
      ws?.emit("open");
      expect(ws?.sent).toEqual([
        JSON.stringify({ type: "text.delta", delta: "hello" }),
        JSON.stringify({ type: "text.done" }),
      ]);

      const audioChunk = Buffer.from("abc").toString("base64");
      ws?.emit("message", JSON.stringify({ type: "audio.delta", delta: audioChunk }));
      ws?.emit("message", JSON.stringify({ type: "audio.done", trace_id: "trace-1" }));

      const result = await resultPromise;
      const reader = result.audioStream.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(Buffer.from(first.value ?? []).toString("utf8")).toBe("abc");
      const second = await reader.read();
      expect(second.done).toBe(true);
      await result.release();
    });

    it("splits text above xAI's 15,000-character limit into ordered delta frames", async () => {
      const text = `${"a".repeat(15_000)}${"b".repeat(15_000)}c`;
      const resultPromise = xaiTTSStream({
        text,
        apiKey: "dummy",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        timeoutMs: 5_000,
      });
      const ws = FakeWebSocket.instances.at(0);
      ws?.emit("open");

      expect(ws?.sent.map((payload) => JSON.parse(payload))).toEqual([
        { type: "text.delta", delta: "a".repeat(15_000) },
        { type: "text.delta", delta: "b".repeat(15_000) },
        { type: "text.delta", delta: "c" },
        { type: "text.done" },
      ]);

      ws?.emit("message", JSON.stringify({ type: "audio.done" }));
      const result = await resultPromise;
      await result.release();
    });

    it("does not split a surrogate pair at the delta frame boundary", async () => {
      const text = `${"a".repeat(14_999)}😀${"b".repeat(15_000)}`;
      const resultPromise = xaiTTSStream({
        text,
        apiKey: "dummy",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        timeoutMs: 5_000,
      });
      const ws = FakeWebSocket.instances.at(0);
      ws?.emit("open");

      const deltas = (ws?.sent ?? []).flatMap((payload) => {
        const frame = JSON.parse(payload) as { type: string; delta?: string };
        return frame.type === "text.delta" && typeof frame.delta === "string" ? [frame.delta] : [];
      });
      expect(deltas.join("")).toBe(text);
      for (const delta of deltas) {
        expect(delta.length).toBeLessThanOrEqual(15_000);
        expect(delta).not.toMatch(
          /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u,
        );
      }

      ws?.emit("message", JSON.stringify({ type: "audio.done" }));
      const result = await resultPromise;
      await result.release();
    });

    it("keeps exactly 15,000 characters in one delta frame", async () => {
      const text = "a".repeat(15_000);
      const resultPromise = xaiTTSStream({
        text,
        apiKey: "dummy",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        timeoutMs: 5_000,
      });
      const ws = FakeWebSocket.instances.at(0);
      ws?.emit("open");

      expect(ws?.sent.map((payload) => JSON.parse(payload))).toEqual([
        { type: "text.delta", delta: text },
        { type: "text.done" },
      ]);

      ws?.emit("message", JSON.stringify({ type: "audio.done" }));
      const result = await resultPromise;
      await result.release();
    });

    it("rejects upgrade failures before streaming starts", async () => {
      const resultPromise = xaiTTSStream({
        text: "hello",
        apiKey: "dummy",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        language: "en",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });
      const ws = FakeWebSocket.instances.at(0);
      ws?.emit("unexpected-response", {}, { statusCode: 401, statusMessage: "Unauthorized" });
      await expect(resultPromise).rejects.toThrow(
        "xAI TTS stream connection failed (401): Unauthorized",
      );
    });

    it("rejects non-native baseUrl hosts before opening a WebSocket", async () => {
      await expect(
        xaiTTSStream({
          text: "hello",
          apiKey: "dummy",
          baseUrl: "https://proxy.example/v1",
          voiceId: "eve",
          language: "en",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow('only supports the native api.x.ai endpoint; got host "proxy.example"');
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("rejects HTTP native baseUrl before opening a WebSocket", async () => {
      await expect(
        xaiTTSStream({
          text: "hello",
          apiKey: "dummy",
          baseUrl: "http://api.x.ai/v1",
          voiceId: "eve",
          language: "en",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("only supports HTTPS for the native api.x.ai endpoint");
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it.each([
      "https://api.x.ai:8443/v1",
      ["https://user", "password@api.x.ai/v1"].join(":"),
      "https://api.x.ai/custom",
      "https://api.x.ai/v1?existing=value",
      "https://api.x.ai/v1#fragment",
    ])("rejects non-canonical native endpoint shape %s", async (baseUrl) => {
      await expect(
        xaiTTSStream({
          text: "hello",
          apiKey: "dummy",
          baseUrl,
          voiceId: "eve",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(`requires the canonical ${XAI_BASE_URL} base URL`);
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("fails promptly when the socket closes before open", async () => {
      const resultPromise = xaiTTSStream({
        text: "hello",
        apiKey: "dummy",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        language: "en",
        responseFormat: "mp3",
        timeoutMs: 60_000,
      });
      const ws = FakeWebSocket.instances.at(0);
      ws?.emit("close");
      await expect(resultPromise).rejects.toThrow("xAI TTS stream connection closed before open");
    });

    it("closes idempotently when released before audio.done", async () => {
      const resultPromise = xaiTTSStream({
        text: "hello",
        apiKey: "dummy",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        language: "en",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });
      const ws = FakeWebSocket.instances.at(0);
      ws?.emit("open");
      const result = await resultPromise;
      await result.release();
      ws?.emit("close");
      await result.release();
      await expect(result.audioStream.getReader().read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    });

    it("refreshes the synthesis idle timeout for each audio chunk", async () => {
      vi.useFakeTimers();
      const resultPromise = xaiTTSStream({
        text: "hello",
        apiKey: "dummy",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        language: "en",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });
      const ws = FakeWebSocket.instances.at(0);
      ws?.emit("open");
      const result = await resultPromise;
      const reader = result.audioStream.getReader();

      vi.advanceTimersByTime(4_000);
      ws?.emit(
        "message",
        JSON.stringify({ type: "audio.delta", delta: Buffer.from("ok").toString("base64") }),
      );
      await reader.read();
      vi.advanceTimersByTime(4_999);

      const timeoutRead = reader.read();
      vi.advanceTimersByTime(1);
      await expect(timeoutRead).rejects.toThrow("xAI TTS stream synthesis timeout");
    });

    it("caps streamed audio responses instead of forwarding oversized output", async () => {
      const resultPromise = xaiTTSStream({
        text: "hello",
        apiKey: "dummy",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        language: "en",
        responseFormat: "mp3",
        timeoutMs: 5_000,
        maxBytes: 4,
      });
      const ws = FakeWebSocket.instances.at(0);
      ws?.emit("open");
      const chunk = Buffer.from("abcdef").toString("base64");
      ws?.emit("message", JSON.stringify({ type: "audio.delta", delta: chunk }));

      const result = await resultPromise;
      await expect(result.audioStream.getReader().read()).rejects.toThrow(
        "xAI TTS audio stream exceeds 4 bytes",
      );
      await result.release();
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
