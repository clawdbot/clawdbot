import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { transcribeSenseAudioAudio } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("transcribeSenseAudioAudio", () => {
  it("uses SenseAudio base URL by default", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeSenseAudioAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
    });

    expect(getRequest().url).toBe("https://api.senseaudio.cn/v1/audio/transcriptions");
  });

  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({ text: "ok" });

    const result = await transcribeSenseAudioAudio({
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

    const result = await transcribeSenseAudioAudio({
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

    expect(result.model).toBe("senseaudio-asr-pro-1.5-260319");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-custom")).toBe("1");

    const form = seenInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("senseaudio-asr-pro-1.5-260319");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("hello");
    const file = form.get("file") as Blob | { type?: string; name?: string } | null;
    if (!file) {
      throw new Error("expected SenseAudio audio file");
    }
    expect(file.type).toBe("audio/wav");
    if (file && "name" in file && typeof file.name === "string") {
      expect(file.name).toBe("voice.wav");
    }
  });

  it("throws when the provider response omits text", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({});

    await expect(
      transcribeSenseAudioAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing text");
  });

  it("can transcribe generated speech in live mode", async () => {
    if (process.env.OPENCLAW_LIVE_TEST !== "1" || !process.env.SENSEAUDIO_API_KEY) {
      return;
    }
    const say = spawnSync("sh", ["-lc", "command -v say"], { encoding: "utf8" });
    if (say.status !== 0) {
      return;
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-senseaudio-live-"));
    try {
      const aiffPath = path.join(tempDir, "speech.aiff");
      const mp3Path = path.join(tempDir, "speech.mp3");
      const sayResult = spawnSync("say", ["-o", aiffPath, "open claw live transcription test"], {
        encoding: "utf8",
      });
      expect(sayResult.status).toBe(0);
      await runFfmpeg(["-y", "-i", aiffPath, "-c:a", "libmp3lame", "-b:a", "96k", mp3Path]);

      const result = await transcribeSenseAudioAudio({
        buffer: readFileSync(mp3Path),
        fileName: "speech.mp3",
        mime: "audio/mpeg",
        apiKey: process.env.SENSEAUDIO_API_KEY,
        timeoutMs: 30_000,
      });

      expect(result.text.trim().length).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
