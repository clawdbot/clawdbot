import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  elevenLabsMediaUnderstandingProvider,
  transcribeElevenLabsAudio,
} from "./media-understanding-provider.js";

function requireFirstFetchCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const [call] = fetchMock.mock.calls;
  if (!call) {
    throw new Error("expected ElevenLabs media fetch call");
  }
  return call as [string, RequestInit];
}

describe("elevenLabsMediaUnderstandingProvider", () => {
  let ssrfMock: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
  });

  it("has expected provider metadata", () => {
    expect(elevenLabsMediaUnderstandingProvider.id).toBe("elevenlabs");
    expect(elevenLabsMediaUnderstandingProvider.capabilities).toEqual(["audio"]);
    expect(elevenLabsMediaUnderstandingProvider.defaultModels?.audio).toBe("scribe_v2");
    expect(elevenLabsMediaUnderstandingProvider.transcribeAudio).toBeTypeOf("function");
  });

  it("posts multipart audio to ElevenLabs speech-to-text", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ text: "hello" })));

    const result = await transcribeElevenLabsAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      mime: "audio/mpeg",
      apiKey: "eleven-key",
      model: "scribe_v2",
      language: "en",
      timeoutMs: 1000,
      fetchFn: fetchMock,
    });

    expect(result).toEqual({ text: "hello", model: "scribe_v2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = requireFirstFetchCall(fetchMock);
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("xi-api-key")).toBe("eleven-key");
    const form = init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });
});
