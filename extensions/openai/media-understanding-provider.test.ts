import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  openaiCodexMediaUnderstandingProvider,
  transcribeOpenAiAudio,
  transcribeOpenAiCodexAudio,
} from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("openaiCodexMediaUnderstandingProvider", () => {
  it("declares audio support with the transcription default", () => {
    expect(openaiCodexMediaUnderstandingProvider.capabilities).toEqual(["image", "audio"]);
    expect(openaiCodexMediaUnderstandingProvider.defaultModels).toEqual({
      image: "gpt-5.5",
      audio: "gpt-4o-transcribe",
    });
    expect(openaiCodexMediaUnderstandingProvider.autoPriority).toEqual({ image: 20, audio: 20 });
    expect(openaiCodexMediaUnderstandingProvider.transcribeAudio).toBe(transcribeOpenAiCodexAudio);
  });
});

describe("transcribeOpenAiAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({ text: "ok" });

    const result = await transcribeOpenAiAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { authorization: "Bearer override" },
      fetchFn,
    });

    expect(getAuthHeader()).toBe("Bearer override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

    const result = await transcribeOpenAiAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      baseUrl: "https://api.example.com/v1/",
      model: " ",
      language: " en ",
      prompt: " hello ",
      mime: "audio/wav",
      headers: { "X-Custom": "1" },
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("gpt-4o-transcribe");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-custom")).toBe("1");

    const form = seenInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("hello");
    const file = form.get("file") as Blob | { type?: string; name?: string } | null;
    expect(file).not.toBeNull();
    if (file) {
      expect(file.type).toBe("audio/wav");
      if ("name" in file && typeof file.name === "string") {
        expect(file.name).toBe("voice.wav");
      }
    }
  });

  it("throws when the provider response omits text", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({});

    await expect(
      transcribeOpenAiAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing text");
  });
});

describe("transcribeOpenAiCodexAudio", () => {
  it("uses the OpenAI transcription default through the Codex provider id", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

    const result = await transcribeOpenAiCodexAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      model: " ",
      fetchFn,
    });

    const form = getRequest().init?.body as FormData;
    expect(result.model).toBe("gpt-4o-transcribe");
    expect(form.get("model")).toBe("gpt-4o-transcribe");
  });
});
