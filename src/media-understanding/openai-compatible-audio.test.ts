// OpenAI-compatible audio tests cover attribution headers, auth selection,
// filename normalization, and stable malformed-response errors.
import { describe, expect, it, vi } from "vitest";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import { VERSION } from "../version.js";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "./audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";

installPinnedHostnameTestHooks();

describe("transcribeOpenAiCompatibleAudio", () => {
  it("adds hidden attribution headers on the native OpenAI audio host", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("originator")).toBe("openclaw");
    expect(headers.get("version")).toBe(VERSION);
    expect(headers.get("user-agent")).toBe(`openclaw/${VERSION}`);
  });

  it("does not add hidden attribution headers on custom OpenAI-compatible hosts", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      baseUrl: "https://proxy.example.com/v1",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("originator")).toBeNull();
    expect(headers.get("version")).toBeNull();
    expect(headers.get("user-agent")).toBeNull();
  });

  it("remaps AAC uploads to an M4A filename before submitting the form", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice-note.aac",
      mime: "audio/aac",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
    });

    const form = getRequest().init?.body;
    expect(form).toBeInstanceOf(FormData);
    const file = (form as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("voice-note.m4a");
  });

  it("omits bearer auth for explicit no-auth requests", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      auth: { kind: "none", source: "local provider" },
      timeoutMs: 1000,
      fetchFn,
      provider: "local-audio",
      baseUrl: "https://audio.example.com/v1",
      defaultBaseUrl: "https://audio.example.com/v1",
      defaultModel: "whisper-local",
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("uses typed api-key auth for bearer headers", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "legacy-key",
      auth: { kind: "api-key", apiKey: "typed-key", source: "test" },
      timeoutMs: 1000,
      fetchFn,
      provider: "local-audio",
      baseUrl: "https://audio.example.com/v1",
      defaultBaseUrl: "https://audio.example.com/v1",
      defaultModel: "whisper-local",
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("authorization")).toBe("Bearer typed-key");
  });

  it("wraps malformed transcription JSON with a stable provider error", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{ nope"));

    await expect(
      transcribeOpenAiCompatibleAudio({
        buffer: Buffer.from("audio"),
        fileName: "note.mp3",
        apiKey: "test-key",
        timeoutMs: 1000,
        fetchFn,
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-transcribe",
      }),
    ).rejects.toThrow("Audio transcription failed: malformed JSON response");
  });

  it("rejects non-object successful transcription JSON with a stable provider error", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify([])));

    await expect(
      transcribeOpenAiCompatibleAudio({
        buffer: Buffer.from("audio"),
        fileName: "note.mp3",
        apiKey: "test-key",
        timeoutMs: 1000,
        fetchFn,
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-transcribe",
      }),
    ).rejects.toThrow("Audio transcription failed: malformed JSON response");
  });
});
