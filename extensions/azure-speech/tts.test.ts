import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  azureSpeechTTS,
  buildAzureSpeechSsml,
  inferAzureSpeechFileExtension,
  isAzureSpeechVoiceCompatible,
  listAzureSpeechVoices,
  normalizeAzureSpeechBaseUrl,
} from "./tts.js";

describe("azure speech tts", () => {
  installPinnedHostnameTestHooks();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("escapes SSML text and attributes", () => {
    expect(
      buildAzureSpeechSsml({
        text: `Tom & "Jerry" <tag>`,
        voice: `en-US-JennyNeural" xml:lang="evil`,
        lang: `en-US" bad="1`,
      }),
    ).toBe(
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
        `xml:lang="en-US&quot; bad=&quot;1">` +
        `<voice name="en-US-JennyNeural&quot; xml:lang=&quot;evil">` +
        `Tom &amp; "Jerry" &lt;tag&gt;</voice></speak>`,
    );
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
      text: "hello",
      apiKey: "speech-key",
      region: "eastus",
      voice: "en-US-JennyNeural",
      lang: "en-US",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      timeoutMs: 1234,
    });

    expect(result).toEqual(Buffer.from("mp3"));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls.at(0) as [string, RequestInit];
    expect(url).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Ocp-Apim-Subscription-Key")).toBe("speech-key");
    expect(headers.get("Content-Type")).toBe("application/ssml+xml");
    expect(headers.get("X-Microsoft-OutputFormat")).toBe("audio-24khz-48kbitrate-mono-mp3");
    expect(init.body).toContain(`<voice name="en-US-JennyNeural">hello</voice>`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
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
    const [url, init] = fetchMock.mock.calls.at(0) as [string, RequestInit];
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
});
