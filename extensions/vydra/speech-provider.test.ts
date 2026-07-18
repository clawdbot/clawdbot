// Vydra tests cover speech provider plugin behavior.
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVydraSpeechProvider } from "./speech-provider.js";

describe("vydra speech provider", () => {
  installPinnedHostnameTestHooks();

  const provider = buildVydraSpeechProvider();
  const originalVydraApiKey = process.env.VYDRA_API_KEY;

  const oversizedJsonResponse = () =>
    new Response(Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  afterEach(() => {
    if (originalVydraApiKey === undefined) {
      delete process.env.VYDRA_API_KEY;
    } else {
      process.env.VYDRA_API_KEY = originalVydraApiKey;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes the default voice and model", async () => {
    expect(provider.models).toEqual(["elevenlabs/tts"]);
    const voices = await provider.listVoices?.({});
    expect(voices).toEqual([
      {
        id: "21m00Tcm4TlvDq8ikWAM",
        name: "Rachel",
      },
    ]);
  });

  it("posts to the tts endpoint and downloads the audio", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            audioUrl: "https://cdn.vydra.ai/generated/test.mp3",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("mp3-data"), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.synthesize({
      text: "OpenClaw test",
      cfg: {} as never,
      providerConfig: { apiKey: "vydra-test-key" },
      target: "audio-file",
      timeoutMs: 30_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.vydra.ai/api/v1/models/elevenlabs/tts");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({
        text: "OpenClaw test",
        voice_id: "21m00Tcm4TlvDq8ikWAM",
      }),
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer vydra-test-key");
    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.audioBuffer).toEqual(Buffer.from("mp3-data"));
  });

  it("does not treat a blank environment API key as configured", () => {
    process.env.VYDRA_API_KEY = "   ";

    expect(provider.isConfigured?.({ providerConfig: {}, timeoutMs: 30_000 })).toBe(false);
  });

  it("rejects blank environment API keys before making requests", async () => {
    process.env.VYDRA_API_KEY = "\t  \n";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.synthesize({
        text: "OpenClaw test",
        cfg: {} as never,
        providerConfig: {},
        target: "audio-file",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("Vydra API key missing");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects generated audio downloads that exceed the configured media cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            audioUrl: "https://cdn.vydra.ai/generated/test.mp3",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("too-large"), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.synthesize({
        text: "OpenClaw test",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } as never,
        providerConfig: { apiKey: "vydra-test-key" },
        target: "audio-file",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("Vydra audio download exceeds 1 bytes");
  });

  it("rejects speech synthesis JSON responses that exceed the provider cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(oversizedJsonResponse()));

    await expect(
      provider.synthesize({
        text: "OpenClaw test",
        cfg: {} as never,
        providerConfig: { apiKey: "vydra-test-key" },
        target: "audio-file",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("Vydra speech synthesis: JSON response exceeds 16777216 bytes");
  });
});
