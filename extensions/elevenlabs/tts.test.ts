import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingErrorResponse } from "../test-support/streaming-error-response.js";
import { elevenLabsTTS } from "./tts.js";

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
        speed: 1.0,
      },
      timeoutMs: 5_000,
    };
  }

  function getHeadersFromFirstFetchCall(fetchMock: ReturnType<typeof vi.fn>): Headers {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    return new Headers(init?.headers);
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

  it("omits the MPEG Accept header for PCM telephony output", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("pcm")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await elevenLabsTTS({
      ...createDefaultTtsRequest(),
      outputFormat: "pcm_22050",
    });

    expect(getHeadersFromFirstFetchCall(fetchMock).has("accept")).toBe(false);
  });
});
