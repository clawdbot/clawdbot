// Azure Speech tests cover tts plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  azureSpeechTTS,
  inferAzureSpeechFileExtension,
  isAzureSpeechVoiceCompatible,
  listAzureSpeechVoices,
  normalizeAzureSpeechBaseUrl,
} from "./tts.js";

describe("azure speech tts", () => {
  installPinnedHostnameTestHooks();

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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes region and endpoint routing", () => {
    expect(normalizeAzureSpeechBaseUrl({ region: "eastus" })).toBe(
      "https://eastus.tts.speech.microsoft.com",
    );
    expect(
      normalizeAzureSpeechBaseUrl({
        endpoint: "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1/",
      }),
    ).toBe("https://eastus.tts.speech.microsoft.com");
    expect(normalizeAzureSpeechBaseUrl({ baseUrl: "https://custom.example.com/" })).toBe(
      "https://custom.example.com",
    );
  });

  it("maps Azure output formats to attachment metadata", () => {
    expect(inferAzureSpeechFileExtension("audio-24khz-48kbitrate-mono-mp3")).toBe(".mp3");
    expect(inferAzureSpeechFileExtension("ogg-24khz-16bit-mono-opus")).toBe(".ogg");
    expect(inferAzureSpeechFileExtension("riff-24khz-16bit-mono-pcm")).toBe(".wav");
    expect(inferAzureSpeechFileExtension("raw-8khz-8bit-mono-mulaw")).toBe(".pcm");
    expect(isAzureSpeechVoiceCompatible("ogg-24khz-16bit-mono-opus")).toBe(true);
    expect(isAzureSpeechVoiceCompatible("webm-24khz-16bit-mono-opus")).toBe(false);
  });

  it("posts SSML to the region endpoint with Azure Speech headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("mp3"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await azureSpeechTTS({
      text: `Tom & "Jerry" <tag>`,
      apiKey: "fixture-value",
      region: "eastus",
      voice: `en-US-JennyNeural" xml:lang="evil`,
      lang: `en-US" bad="1`,
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      timeoutMs: 1234,
    });

    expect(result).toEqual(Buffer.from("mp3"));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Ocp-Apim-Subscription-Key")).toBe("fixture-value");
    expect(headers.get("Content-Type")).toBe("application/ssml+xml");
    expect(headers.get("X-Microsoft-OutputFormat")).toBe("audio-24khz-48kbitrate-mono-mp3");
    expect(init.body).toBe(
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
        `xml:lang="en-US&quot; bad=&quot;1">` +
        `<voice name="en-US-JennyNeural&quot; xml:lang=&quot;evil">` +
        `Tom &amp; "Jerry" &lt;tag&gt;</voice></speak>`,
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("caps streamed audio responses instead of buffering oversized TTS output", async () => {
    const streamed = createStreamingAudioResponse({
      chunkCount: 20,
      chunkSize: 1024,
      byte: 121,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed.response));

    await expect(
      azureSpeechTTS({
        text: "hello",
        apiKey: "speech-key",
        region: "eastus",
        voice: "en-US-JennyNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        timeoutMs: 1234,
        maxBytes: 2048,
      }),
    ).rejects.toThrow("Azure Speech TTS audio response exceeds 2048 bytes");

    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("lists voices with timeout and filters deprecated entries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            ShortName: "en-US-JennyNeural",
            DisplayName: "Jenny",
            Locale: "en-US",
            Gender: "Female",
            Status: "GA",
            VoiceTag: { VoicePersonalities: ["Warm"] },
          },
          { ShortName: "en-US-OldNeural", DisplayName: "Old", Status: "Deprecated" },
          { ShortName: "en-US-RetiredNeural", DisplayName: "Retired", IsDeprecated: true },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const voices = await listAzureSpeechVoices({
      apiKey: "speech-key",
      baseUrl: "https://custom.example.com",
      timeoutMs: 4321,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom.example.com/cognitiveservices/voices/list");
    expect(new Headers(init.headers).get("Ocp-Apim-Subscription-Key")).toBe("speech-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(voices).toEqual([
      {
        id: "en-US-JennyNeural",
        name: "Jenny",
        description: "Warm",
        locale: "en-US",
        gender: "Female",
        personalities: ["Warm"],
      },
    ]);
  });

  it("returns an empty catalog for a malformed top-level voice payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("null", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      listAzureSpeechVoices({
        apiKey: "speech-key",
        baseUrl: "https://custom.example.com",
      }),
    ).resolves.toEqual([]);
  });

  it("skips malformed voice rows without discarding valid entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            null,
            "unexpected",
            [],
            { ShortName: 42 },
            {
              ShortName: "en-US-JennyNeural",
              DisplayName: "Jenny",
              Locale: "en-US",
              Gender: "Female",
              Status: "GA",
              VoiceTag: {
                TailoredScenarios: [null, "Conversational"],
                VoicePersonalities: [false, "Warm", "  "],
              },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      listAzureSpeechVoices({
        apiKey: "speech-key",
        baseUrl: "https://custom.example.com",
      }),
    ).resolves.toEqual([
      {
        id: "en-US-JennyNeural",
        name: "Jenny",
        description: "Conversational, Warm",
        locale: "en-US",
        gender: "Female",
        personalities: ["Warm"],
      },
    ]);
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
      azureSpeechTTS({
        text: "hello",
        apiKey: "fixture-value",
        region: "eastus",
        voice: "en-US-JennyNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Azure Speech TTS API error: malformed audio response");
  });

  it("closes the upstream socket for a never-ending malformed response over a real connection", async () => {
    let notifySocketClosed: ((closed: boolean) => void) | undefined;
    const socketClosed = new Promise<boolean>((resolve) => {
      notifySocketClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once("close", () => notifySocketClosed?.(true));
      response.writeHead(200, { "content-type": "application/json" });
      // Headers land, then the body never ends: only an explicit cancel closes this.
      response.write('{"error":"still streaming');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = server.address() as AddressInfo;
      await expect(
        azureSpeechTTS({
          text: "hello",
          apiKey: "fixture-value",
          endpoint: `http://127.0.0.1:${port}`,
          voice: "en-US-JennyNeural",
          lang: "en-US",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("Azure Speech TTS API error: malformed audio response");

      await expect(
        withTimeout(socketClosed, 250, {
          message: "Azure Speech malformed-response socket did not close",
        }),
      ).resolves.toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
