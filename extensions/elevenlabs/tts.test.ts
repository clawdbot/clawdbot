import { afterEach, describe, expect, it, vi } from "vitest";
import { elevenLabsTTS } from "./tts.js";

describe("elevenlabs tts diagnostics", () => {
  const originalFetch = globalThis.fetch;

  function createStreamingErrorResponse(params: {
    status: number;
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
      response: new Response(stream, { status: params.status }),
      getReadCount: () => reads,
    };
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

    await expect(
      elevenLabsTTS({
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
          speed: 1.0,
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(
      "ElevenLabs API error (429): Quota exceeded [code=quota_exceeded] [request_id=el_req_456]",
    );
  });

  it("falls back to raw body text when the error body is non-JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("service unavailable", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      elevenLabsTTS({
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
          speed: 1.0,
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("ElevenLabs API error (503): service unavailable");
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

    await expect(
      elevenLabsTTS({
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
          speed: 1.0,
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("ElevenLabs API error (503)");

    expect(streamed.getReadCount()).toBeLessThan(200);
  });
});
