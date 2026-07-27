// Elevenlabs tests cover tts plugin behavior.
import { MAX_AUDIO_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { synthesizeElevenLabsLiveSpeech } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingErrorResponse } from "../test-support/streaming-error-response.js";
import { elevenLabsTTS, elevenLabsTTSStream } from "./tts.js";

describe("elevenlabs tts diagnostics", () => {
  const originalFetch = globalThis.fetch;

  function createDefaultTtsRequest() {
    return {
      text: "hello",
      apiKey: "test-key",
      baseUrl: "https://api.elevenlabs.io",
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
      outputFormat: "mp3_44100_128",
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0,
        useSpeakerBoost: true,
        speed: 1,
      },
      timeoutMs: 5_000,
    };
  }

  function getHeadersFromFirstFetchCall(fetchMock: ReturnType<typeof vi.fn>): Headers {
    return new Headers(getInitFromFirstFetchCall(fetchMock).headers);
  }

  function requireFirstFetchCall(fetchMock: ReturnType<typeof vi.fn>): [string | URL, RequestInit] {
    const [call] = fetchMock.mock.calls;
    if (!call) {
      throw new Error("expected ElevenLabs fetch call");
    }
    return call as [string | URL, RequestInit];
  }

  function getInitFromFirstFetchCall(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
    const [, init] = requireFirstFetchCall(fetchMock);
    return init;
  }

  function getUrlFromFirstFetchCall(fetchMock: ReturnType<typeof vi.fn>): URL {
    const [url] = requireFirstFetchCall(fetchMock);
    return new URL(url.toString());
  }

  async function expectDefaultTtsRequestToThrow(message: string | RegExp) {
    await expect(elevenLabsTTS(createDefaultTtsRequest())).rejects.toThrow(message);
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("includes parsed provider detail and request id for JSON API errors", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: {
              message: "Quota exceeded",
              status: "quota_exceeded",
            },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "x-request-id": "el_req_456",
            },
          },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expectDefaultTtsRequestToThrow(
      "ElevenLabs API error (429): Quota exceeded [code=quota_exceeded] [request_id=el_req_456]",
    );
  });

  it("falls back to raw body text when the error body is non-JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("service unavailable", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expectDefaultTtsRequestToThrow("ElevenLabs API error (503): service unavailable");
  });

  it("caps streamed non-JSON error reads instead of consuming full response bodies", async () => {
    const streamed = createStreamingErrorResponse({
      status: 503,
      chunkCount: 200,
      chunkSize: 1024,
      byte: 121,
    });
    const fetchMock = vi.fn(async () => streamed.response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expectDefaultTtsRequestToThrow("ElevenLabs API error (503)");

    expect(streamed.getReadCount()).toBeLessThan(200);
  });

  it("keeps the MPEG Accept header for MP3 output", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("mp3")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await elevenLabsTTS(createDefaultTtsRequest());

    expect(getHeadersFromFirstFetchCall(fetchMock).get("accept")).toBe("audio/mpeg");
  });

  it("rejects JSON success bodies as malformed audio", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not audio" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expectDefaultTtsRequestToThrow("ElevenLabs API error: malformed audio response");
  });

  it("rejects empty successful audio bodies as malformed audio", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array()));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expectDefaultTtsRequestToThrow("ElevenLabs API error: malformed audio response");
  });

  it("omits the MPEG Accept header for PCM telephony output", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("pcm")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await elevenLabsTTS({
      ...createDefaultTtsRequest(),
      outputFormat: "pcm_22050",
    });

    expect(getHeadersFromFirstFetchCall(fetchMock).has("accept")).toBe(false);
  });

  it("sends latency optimization as an ElevenLabs query parameter", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("mp3")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await elevenLabsTTS({
      ...createDefaultTtsRequest(),
      latencyTier: 3,
    });

    const url = getUrlFromFirstFetchCall(fetchMock);
    expect(url.searchParams.get("optimize_streaming_latency")).toBe("3");
    const body = JSON.parse(getInitFromFirstFetchCall(fetchMock).body as string) as {
      latency_optimization_level?: number;
    };
    expect(body.latency_optimization_level).toBeUndefined();
  });

  it("rejects fractional latency optimization instead of truncating it", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("mp3")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      elevenLabsTTS({
        ...createDefaultTtsRequest(),
        latencyTier: 3.9,
      }),
    ).rejects.toThrow("latencyTier must be an integer");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits latency optimization for eleven_v3 because the API rejects it", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("mp3")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await elevenLabsTTS({
      ...createDefaultTtsRequest(),
      modelId: "eleven_v3",
      latencyTier: 3,
    });

    const url = getUrlFromFirstFetchCall(fetchMock);
    expect(url.searchParams.has("optimize_streaming_latency")).toBe(false);
  });

  it("uses the streaming endpoint without buffering the audio body", async () => {
    const audioStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(audioStream));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await elevenLabsTTSStream({
      ...createDefaultTtsRequest(),
      latencyTier: 2,
    });
    try {
      const url = getUrlFromFirstFetchCall(fetchMock);
      expect(url.pathname).toBe("/v1/text-to-speech/pMsXgVXv3BLzUgSXRplE/stream");
      expect(url.searchParams.get("optimize_streaming_latency")).toBe("2");
      const reader = result.audioStream.getReader();
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: new Uint8Array([1, 2, 3]),
      });
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      expect(audioStream.locked).toBe(false);
    } finally {
      await result.release();
    }
  });

  it("releases an unread provider stream when the public release hook runs", async () => {
    const cancel = vi.fn();
    const audioStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel,
    });
    const fetchMock = vi.fn(
      async () => new Response(audioStream, { headers: { "content-type": "audio/mpeg" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await elevenLabsTTSStream(createDefaultTtsRequest());
    try {
      expect(audioStream.locked).toBe(true);

      await result.release();
      await result.release();

      expect(cancel).toHaveBeenCalledOnce();
      expect(audioStream.locked).toBe(false);
    } finally {
      await result.audioStream.cancel().catch(() => undefined);
      await result.release();
    }
  });

  it("releases a partially consumed provider stream while its consumer holds a reader", async () => {
    const cancel = vi.fn();
    const audioStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel,
    });
    const fetchMock = vi.fn(
      async () => new Response(audioStream, { headers: { "content-type": "audio/mpeg" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await elevenLabsTTSStream(createDefaultTtsRequest());
    const reader = result.audioStream.getReader();
    try {
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: new Uint8Array([1, 2, 3]),
      });

      await result.release();

      expect(cancel).toHaveBeenCalledOnce();
      expect(audioStream.locked).toBe(false);
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await result.release();
    }
  });

  it("cancels streamed audio before delivering bytes beyond the audio limit", async () => {
    const cancel = vi.fn();
    const audioStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const fetchMock = vi.fn(
      async () => new Response(audioStream, { headers: { "content-type": "audio/mpeg" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await elevenLabsTTSStream(createDefaultTtsRequest());
    try {
      const reader = result.audioStream.getReader();

      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value).toHaveLength(MAX_AUDIO_BYTES);
      await expect(reader.read()).rejects.toThrow(
        `ElevenLabs API error: audio response exceeds ${MAX_AUDIO_BYTES} bytes`,
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(audioStream.locked).toBe(false);
    } finally {
      await result.release();
    }
  });

  it("rejects JSON success stream responses as malformed audio", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not audio" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(elevenLabsTTSStream(createDefaultTtsRequest())).rejects.toThrow(
      "ElevenLabs API error: malformed audio response",
    );
  });
});

describe("elevenlabs live audio helper error-path body release", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("cancels an unread streaming error body when ElevenLabs returns non-2xx", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel,
      }),
      { status: 401 },
    );
    globalThis.fetch = vi.fn(async () => response) as typeof fetch;

    await expect(
      synthesizeElevenLabsLiveSpeech({
        text: "OpenClaw leak check.",
        apiKey: "x",
        outputFormat: "mp3_44100_128",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("ElevenLabs live TTS failed (401)");

    expect(cancel).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });
});
