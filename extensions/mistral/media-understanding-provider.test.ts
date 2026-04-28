import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("mistralMediaUnderstandingProvider", () => {
  it("has expected provider metadata", () => {
    expect(mistralMediaUnderstandingProvider.id).toBe("mistral");
    expect(mistralMediaUnderstandingProvider.capabilities).toEqual(["audio"]);
    expect(mistralMediaUnderstandingProvider.transcribeAudio).toBeDefined();
  });

  it("uses Mistral base URL by default", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "bonjour" });

    const result = await mistralMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.ogg",
      apiKey: "test-mistral-key",
      timeoutMs: 5000,
      fetchFn,
    });

    expect(getRequest().url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect(result.text).toBe("bonjour");
  });

  it("allows overriding baseUrl", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await mistralMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "key",
      timeoutMs: 1000,
      baseUrl: "https://custom.mistral.example/v1",
      fetchFn,
    });

    expect(getRequest().url).toBe("https://custom.mistral.example/v1/audio/transcriptions");
  });
});
