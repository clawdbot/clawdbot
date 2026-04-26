import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSTTConfig, transcribeAudio } from "./stt.js";

describe("engine/utils/stt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves plugin STT config and falls back to provider credentials", () => {
    const cfg = {
      channels: {
        qqbot: {
          stt: {
            provider: "openai",
            baseUrl: "https://api.example.test/v1///",
            model: "whisper-large",
          },
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: "provider-key",
          },
        },
      },
    };

    expect(resolveSTTConfig(cfg)).toEqual({
      baseUrl: "https://api.example.test/v1",
      apiKey: "provider-key",
      model: "whisper-large",
    });
  });

  it("falls back to framework audio model config when plugin STT is disabled", () => {
    const cfg = {
      channels: { qqbot: { stt: { enabled: false, apiKey: "ignored" } } },
      tools: {
        media: {
          audio: {
            models: [{ provider: "local", baseUrl: "https://stt.example.test/", model: "sense" }],
          },
        },
      },
      models: {
        providers: {
          local: { apiKey: "local-key" },
        },
      },
    };

    expect(resolveSTTConfig(cfg)).toEqual({
      baseUrl: "https://stt.example.test",
      apiKey: "local-key",
      model: "sense",
    });
  });

  it("returns null when no usable STT credentials are configured", () => {
    expect(resolveSTTConfig({ channels: { qqbot: { stt: { baseUrl: "https://x.test" } } } })).toBe(
      null,
    );
    expect(resolveSTTConfig({})).toBe(null);
  });

  it("posts audio to OpenAI-compatible transcription endpoint", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qqbot-stt-"));
    const audioPath = path.join(tmpDir, "voice.wav");
    fs.writeFileSync(audioPath, Buffer.from([1, 2, 3, 4]));

    const fetchMock = vi.fn(async () =>
      Response.json({
        text: "hello from audio",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const transcript = await transcribeAudio(audioPath, {
      channels: {
        qqbot: {
          stt: {
            baseUrl: "https://api.example.test/v1/",
            apiKey: "secret",
            model: "whisper-1",
          },
        },
      },
    });

    expect(transcript).toBe("hello from audio");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: expect.any(FormData),
      }),
    );
  });
});
