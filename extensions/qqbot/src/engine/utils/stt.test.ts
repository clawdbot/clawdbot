// Qqbot tests cover stt plugin behavior.
import * as fs from "node:fs";
import * as path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
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

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

function largeTranscriptionJsonResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
} {
  let chunkIndex = 0;
  const encoder = new TextEncoder();
  const chunks = [
    '{"text":"',
    ...Array.from({ length: params.chunkCount }, () => "a".repeat(params.chunkSize)),
    '"}',
  ];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunkIndex >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[chunkIndex]));
      chunkIndex += 1;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    getReadCount: () => chunkIndex,
  };
}

function requireFirstSsrfRequest(): {
  url?: unknown;
  auditContext?: unknown;
  init?: RequestInit;
  timeoutMs?: unknown;
} {
  const [call] = ssrfRuntimeMocks.fetchWithSsrFGuard.mock.calls;
  if (!call) {
    throw new Error("expected QQBot STT fetch call");
  }
  return call[0] as {
    url?: unknown;
    auditContext?: unknown;
    init?: RequestInit;
    timeoutMs?: unknown;
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
            timeoutSeconds: 45,
          },
        },
      },
    };

    expect(resolveSTTConfig(cfg)).toEqual({
      baseUrl: "https://api.example.test/v1",
      apiKey: "provider-key",
      model: "whisper-large",
      timeoutMs: 45_000,
    });
  });

  it("falls back to a generic framework media model when plugin STT is disabled", () => {
    const cfg = {
      channels: { qqbot: { stt: { enabled: false, apiKey: "ignored" } } },
      tools: {
        media: {
          models: [
            {
              provider: "local",
              baseUrl: "https://stt.example.test/",
              model: "sense",
            },
          ],
          audio: {
            timeoutSeconds: 90,
          },
        },
      },
      models: {
        providers: {
          local: { apiKey: "local-key", timeoutSeconds: 120 },
        },
      },
    };

    expect(resolveSTTConfig(cfg)).toEqual({
      baseUrl: "https://stt.example.test",
      apiKey: "local-key",
      model: "sense",
      timeoutMs: 90_000,
    });

    Object.assign(expectDefined(cfg.tools.media.models[0], "QQBot STT model"), {
      timeoutSeconds: 75,
    });
    expect(resolveSTTConfig(cfg)?.timeoutMs).toBe(75_000);
  });

  it("returns null when no usable STT credentials are configured", () => {
    expect(resolveSTTConfig({ channels: { qqbot: { stt: { baseUrl: "https://x.test" } } } })).toBe(
      null,
    );
    expect(resolveSTTConfig({})).toBe(null);
  });

  it("posts audio to OpenAI-compatible transcription endpoint", async () => {
    await withTempDir("openclaw-qqbot-stt-", async (tmpDir) => {
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
      expect(request.timeoutMs).toBe(60_000);
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

  it("bounds successful STT JSON responses before parsing", async () => {
    await withTempDir("openclaw-qqbot-stt-success-limit-", async (tmpDir) => {
      const audioPath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(audioPath, Buffer.from([1, 2, 3, 4]));

      const release = vi.fn(async () => {});
      const streamed = largeTranscriptionJsonResponse({
        chunkCount: 18,
        chunkSize: 1024 * 1024,
      });
      ssrfRuntimeMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: streamed.response,
        release,
      });

      let error: unknown;
      try {
        await transcribeAudio(audioPath, {
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
      } catch (caught) {
        error = caught;
      }

      expect(String(error)).toContain("qqbot.stt: JSON response exceeds 16777216 bytes");
      expect(streamed.getReadCount()).toBeLessThan(20);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("bounds STT error bodies on a UTF-16 boundary without using response.text()", async () => {
    await withTempDir("openclaw-qqbot-stt-error-", async (tmpDir) => {
      const audioPath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(audioPath, Buffer.from([1, 2, 3, 4]));

      const release = vi.fn(async () => {});
      const safePrefix = "x".repeat(299);
      const tracked = cancelTrackedResponse(`${safePrefix}🎉${"tail".repeat(4096)}`, {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "text/plain" },
      });
      const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
      ssrfRuntimeMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: tracked.response,
        release,
      });

      let error: unknown;
      try {
        await transcribeAudio(audioPath, {
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
      } catch (caught) {
        error = caught;
      }

      expect((error as Error).message).toBe(`STT failed (HTTP 503): ${safePrefix}`);
      expect(tracked.wasCanceled()).toBe(true);
      expect(textSpy).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    });
  });
});
