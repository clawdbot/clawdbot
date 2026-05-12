import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: ssrfRuntimeMocks.fetchWithSsrFGuard,
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

import { resolveSTTConfig, transcribeAudio } from "./stt.js";

function requireFirstSsrfRequest(): {
  url?: unknown;
  auditContext?: unknown;
  init?: RequestInit;
} {
  const [call] = ssrfRuntimeMocks.fetchWithSsrFGuard.mock.calls;
  if (!call) {
    throw new Error("expected QQBot STT fetch call");
  }
  return call[0] as {
    url?: unknown;
    auditContext?: unknown;
    init?: RequestInit;
  };
}

describe("engine/utils/stt", () => {
  beforeEach(() => {
    ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
    ssrfRuntimeMocks.fetchWithSsrFGuard.mockImplementation(
      async ({ url, init }: { url: string; init?: RequestInit }) => ({
        response: await fetch(url, init),
        release: vi.fn(async () => {}),
      }),
    );
  });

  afterEach(() => {
    ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
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

    const release = vi.fn(async () => {});
    ssrfRuntimeMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: Response.json({
        text: "hello from audio",
      }),
      release,
    });

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
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    const request = requireFirstSsrfRequest();
    expect(request.url).toBe("https://api.example.test/v1/audio/transcriptions");
    expect(request.auditContext).toBe("qqbot-stt");
    expect(request.init?.method).toBe("POST");
    expect(request.init?.headers).toEqual({ Authorization: "Bearer secret" });
    expect(request.init?.body).toBeInstanceOf(FormData);
    const body = request.init?.body as FormData;
    expect(body.get("model")).toBe("whisper-1");
    const file = body.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("voice.wav");
    expect((file as File).type).toBe("audio/wav");
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
