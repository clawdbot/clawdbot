// Gradium tests cover tts plugin behavior.
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gradiumTTS } from "./tts.js";

describe("gradium tts diagnostics", () => {
  installPinnedHostnameTestHooks();

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

  function createStreamingAudioResponse(params: {
    chunkCount: number;
    chunkSize: number;
    byte: number;
  }): { response: Response; getReadCount: () => number } {
    return createStreamingErrorResponse({ ...params, status: 200 });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("includes parsed provider detail and request id for JSON API errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Invalid API key",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": "grad_req_123",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      gradiumTTS({
        text: "hello",
        apiKey: "bad-key",
        baseUrl: "https://api.gradium.ai",
        voiceId: "YTpq7expH9539ERJ",
        outputFormat: "wav",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Gradium API error (401): Invalid API key [request_id=grad_req_123]");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to raw body text when the error body is non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("service unavailable", { status: 503 })),
    );

    await expect(
      gradiumTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://api.gradium.ai",
        voiceId: "YTpq7expH9539ERJ",
        outputFormat: "wav",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Gradium API error (503): service unavailable");
  });

  it("caps streamed non-JSON error reads instead of consuming full response bodies", async () => {
    const streamed = createStreamingErrorResponse({
      status: 503,
      chunkCount: 200,
      chunkSize: 1024,
      byte: 121,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed.response));

    await expect(
      gradiumTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://api.gradium.ai",
        voiceId: "YTpq7expH9539ERJ",
        outputFormat: "wav",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Gradium API error (503)");

    expect(streamed.getReadCount()).toBeLessThan(200);
  });

  it("sends the correct request payload", async () => {
    const audioData = Buffer.from("fake-wav-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await gradiumTTS({
      text: "Hello world",
      apiKey: "gsk_test123",
      baseUrl: "https://api.gradium.ai",
      voiceId: "YTpq7expH9539ERJ",
      outputFormat: "wav",
      timeoutMs: 5_000,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.gradium.ai/api/post/speech/tts");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("gsk_test123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Hello world",
      voice_id: "YTpq7expH9539ERJ",
      only_audio: true,
      output_format: "wav",
      json_config: '{"padding_bonus":0}',
    });
    expect(result).toEqual(audioData);
  });

  for (const { name, baseUrl, expectedError } of [
    {
      name: "rejects HTTP base URLs before sending the API key",
      baseUrl: "http://api.gradium.ai",
      expectedError: "Gradium baseUrl must use https",
    },
    {
      name: "rejects non-Gradium base URLs before sending the API key",
      baseUrl: "https://example.com",
      expectedError: "Gradium baseUrl must target api.gradium.ai",
    },
    {
      name: "rejects hostname suffix lookalikes before sending the API key",
      baseUrl: "https://api.gradium.ai.example.com",
      expectedError: "Gradium baseUrl must target api.gradium.ai",
    },
  ]) {
    it(name, async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(Buffer.from("audio"), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        gradiumTTS({
          text: "hello",
          apiKey: "gsk_test123",
          baseUrl,
          voiceId: "YTpq7expH9539ERJ",
          outputFormat: "wav",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(expectedError);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("caps streamed audio responses instead of buffering oversized TTS output", async () => {
    const streamed = createStreamingAudioResponse({
      chunkCount: 20,
      chunkSize: 1024,
      byte: 121,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed.response));

    await expect(
      gradiumTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://api.gradium.ai",
        voiceId: "YTpq7expH9539ERJ",
        outputFormat: "wav",
        timeoutMs: 5_000,
        maxBytes: 2048,
      }),
    ).rejects.toThrow("Gradium TTS audio response exceeds 2048 bytes");

    expect(streamed.getReadCount()).toBeLessThan(20);
  });
  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
    { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
    { name: "empty audio", contentType: "audio/mpeg", body: "" },
  ])("rejects a successful $name response as synthesized audio", async ({ contentType, body }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { "content-type": contentType } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      gradiumTTS({
        text: "hello",
        apiKey: "ok-key",
        baseUrl: "https://api.gradium.ai",
        voiceId: "YTpq7expH9539ERJ",
        outputFormat: "wav",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Gradium API error: malformed audio response");
  });
});
