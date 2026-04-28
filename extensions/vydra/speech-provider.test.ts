import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVydraSpeechProvider } from "./speech-provider.js";

describe("vydra speech provider", () => {
  installPinnedHostnameTestHooks();

  const provider = buildVydraSpeechProvider();

  afterEach(() => {
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

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.vydra.ai/api/v1/models/elevenlabs/tts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          text: "OpenClaw test",
          voice_id: "21m00Tcm4TlvDq8ikWAM",
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer vydra-test-key");
    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.audioBuffer).toEqual(Buffer.from("mp3-data"));
  });
});
