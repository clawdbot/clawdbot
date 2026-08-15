// Soniox audio tests cover the async transcription job flow with a mocked fetch.
import { describe, expect, it, vi } from "vitest";
import { transcribeSonioxAudio } from "./audio.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createSonioxFetchMock() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    if (url.endsWith("/files") && method === "POST") {
      return jsonResponse({ id: "file-1", filename: "audio.wav" });
    }
    if (url.endsWith("/transcriptions") && method === "POST") {
      return jsonResponse({ id: "transcription-1", status: "processing" });
    }
    if (url.endsWith("/transcriptions/transcription-1") && method === "GET") {
      return jsonResponse({ id: "transcription-1", status: "completed" });
    }
    if (url.endsWith("/transcriptions/transcription-1/transcript") && method === "GET") {
      return jsonResponse({ id: "transcription-1", text: "Hello world", tokens: [] });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
}

describe("transcribeSonioxAudio", () => {
  it("uploads, creates a job, polls, and returns the transcript", async () => {
    const fetchFn = createSonioxFetchMock();
    const result = await transcribeSonioxAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(result).toEqual({ text: "Hello world", model: "stt-async-v5" });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    const uploadCall = fetchFn.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/files") && (init as RequestInit | undefined)?.method === "POST",
    );
    const uploadInit = uploadCall?.[1] as RequestInit | undefined;
    expect(uploadInit?.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "User-Agent": "OpenClaw",
    });
    expect(uploadInit?.body).toBeInstanceOf(FormData);
  });

  it("honors language and model overrides in the job body", async () => {
    const fetchFn = createSonioxFetchMock();
    await transcribeSonioxAudio({
      buffer: Buffer.from("x"),
      fileName: "v.wav",
      apiKey: "k",
      language: "zh",
      model: "custom-model",
      timeoutMs: 5000,
      fetchFn,
    });
    const createCall = fetchFn.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/transcriptions") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body));
    expect(body).toMatchObject({ model: "custom-model", language_hints: ["zh"] });
    expect(body).not.toHaveProperty("enable_speaker_diarization");
  });

  it("adds enable_speaker_diarization only when configured", async () => {
    const fetchFn = createSonioxFetchMock();
    await transcribeSonioxAudio({
      buffer: Buffer.from("x"),
      fileName: "v.wav",
      apiKey: "k",
      enableSpeakerDiarization: true,
      timeoutMs: 5000,
      fetchFn,
    });
    const createCall = fetchFn.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/transcriptions") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body));
    expect(body).toMatchObject({ enable_speaker_diarization: true });
  });

  it("throws when the job fails with the provider error message", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/files") && method === "POST") {
        return jsonResponse({ id: "file-1" });
      }
      if (url.endsWith("/transcriptions") && method === "POST") {
        return jsonResponse({ id: "t-1", status: "processing" });
      }
      if (url.endsWith("/transcriptions/t-1") && method === "GET") {
        return jsonResponse({ id: "t-1", status: "failed", error_message: "audio too short" });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    await expect(
      transcribeSonioxAudio({
        buffer: Buffer.from("x"),
        fileName: "v.wav",
        apiKey: "k",
        timeoutMs: 5000,
        fetchFn,
      }),
    ).rejects.toThrow("audio too short");
  });

  it("throws when the transcript omits text", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/files") && method === "POST") {
        return jsonResponse({ id: "file-1" });
      }
      if (url.endsWith("/transcriptions") && method === "POST") {
        return jsonResponse({ id: "t-1", status: "processing" });
      }
      if (url.endsWith("/transcriptions/t-1") && method === "GET") {
        return jsonResponse({ id: "t-1", status: "completed" });
      }
      if (url.endsWith("/transcriptions/t-1/transcript") && method === "GET") {
        return jsonResponse({ id: "t-1", text: "" });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    await expect(
      transcribeSonioxAudio({
        buffer: Buffer.from("x"),
        fileName: "v.wav",
        apiKey: "k",
        timeoutMs: 5000,
        fetchFn,
      }),
    ).rejects.toThrow("Soniox transcription response missing transcript");
  });
});
