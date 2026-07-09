// Openrouter tests cover music generation provider plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterMusicGenerationProvider } from "./music-generation-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  postJsonRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "openrouter-key",
    source: "env",
    mode: "api-key",
  })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...original,
    assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
    postJsonRequest: postJsonRequestMock,
    resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  };
});

function sseResponse(
  lines: Array<string | Uint8Array>,
  options?: { cancel?: () => void; releaseLock?: () => void },
): Response {
  const encoder = new TextEncoder();
  const encodeLine = (line: string | Uint8Array) =>
    typeof line === "string" ? encoder.encode(line) : line;
  if (!options?.releaseLock && !options?.cancel) {
    let index = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          const line = lines[index++];
          if (line === undefined) {
            controller.close();
            return;
          }
          controller.enqueue(encodeLine(line));
        },
        cancel() {
          options?.cancel?.();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  const chunks: Array<ReadableStreamReadResult<Uint8Array>> = lines.map((line) => ({
    done: false,
    value: encodeLine(line),
  }));
  chunks.push({ done: true, value: undefined });
  const reader = {
    read: async () => chunks.shift() ?? { done: true, value: undefined },
    cancel: async () => options?.cancel?.(),
    releaseLock: options?.releaseLock ?? (() => {}),
  } as ReadableStreamDefaultReader<Uint8Array>;

  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader: () => reader,
    },
  } as Response;
}

function sseResponseLines(params: {
  audio?: string;
  transcript?: string;
  done?: boolean;
}): string[] {
  const lines: string[] = [];
  if (params.audio || params.transcript) {
    lines.push(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              audio: {
                ...(params.audio ? { data: params.audio } : {}),
                ...(params.transcript ? { transcript: params.transcript } : {}),
              },
            },
          },
        ],
      })}\n`,
    );
  }
  if (params.done) {
    lines.push("data: [DONE]\n");
  }
  return lines;
}

function stalledSseResponse(line: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(line));
      },
      cancel() {},
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function postRequest(): Record<string, unknown> {
  const request = postJsonRequestMock.mock.calls[0]?.[0];
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter music request");
  }
  return request as Record<string, unknown>;
}

function resetOpenRouterMusicMocks() {
  assertOkOrThrowHttpErrorMock.mockResolvedValue(undefined);
  postJsonRequestMock.mockReset();
  resolveApiKeyForProviderMock.mockResolvedValue({
    apiKey: "openrouter-key",
    source: "env",
    mode: "api-key",
  });
  resolveProviderHttpRequestConfigMock.mockImplementation((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  }));
}

describe("openrouter music generation provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetOpenRouterMusicMocks();
  });

  afterEach(() => {
    resetOpenRouterMusicMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitMusicGenerationCapabilities(buildOpenRouterMusicGenerationProvider());
  });

  it("streams OpenRouter audio chunks into a generated music asset", async () => {
    const release = vi.fn(async () => {});
    const audioBase64 = Buffer.from("wav-bytes").toString("base64");
    postJsonRequestMock.mockResolvedValue({
      response: sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { transcript: "line " } } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: audioBase64.slice(0, 5) } } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: audioBase64.slice(5), transcript: "two" } } }] })}\n`,
        "data: [DONE]\n",
      ]),
      release,
    });

    const result = await buildOpenRouterMusicGenerationProvider().generateMusic({
      provider: "openrouter",
      model: "",
      prompt: "bright soundtrack",
      cfg: {},
      instrumental: true,
      format: "wav",
    });

    expect(postRequest().url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(postRequest().body).toEqual({
      model: "google/lyria-3-pro-preview",
      messages: [
        {
          role: "user",
          content:
            "bright soundtrack\n\nInstrumental only. No vocals, no sung lyrics, no spoken word.",
        },
      ],
      modalities: ["text", "audio"],
      audio: { format: "wav" },
      stream: true,
    });
    expect(result.tracks[0]?.mimeType).toBe("audio/wav");
    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("wav-bytes"));
    expect(result.lyrics).toEqual(["line two"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases OpenRouter audio stream readers after completion", async () => {
    const releaseLock = vi.fn();
    postJsonRequestMock.mockResolvedValue({
      response: sseResponse(
        sseResponseLines({
          audio: Buffer.from("wav-bytes").toString("base64"),
          done: true,
        }),
        { releaseLock },
      ),
      release: vi.fn(async () => {}),
    });

    await expect(
      buildOpenRouterMusicGenerationProvider().generateMusic({
        provider: "openrouter",
        model: "google/lyria-3-pro-preview",
        prompt: "release stream reader",
        cfg: {},
      }),
    ).resolves.toMatchObject({
      tracks: [{ mimeType: "audio/wav" }],
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("decodes independently padded OpenRouter audio chunks", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from("a").toString("base64") } } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from("b").toString("base64") } } }] })}\n`,
        "data: [DONE]\n",
      ]),
      release: vi.fn(async () => {}),
    });

    const result = await buildOpenRouterMusicGenerationProvider().generateMusic({
      provider: "openrouter",
      model: "google/lyria-3-pro-preview",
      prompt: "chunked soundtrack",
      cfg: {},
    });

    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("ab"));
  });

  it("sends reference images as multimodal message content", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from("mp3").toString("base64") } } }] })}\n`,
        "data: [DONE]\n",
      ]),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterMusicGenerationProvider().generateMusic({
      provider: "openrouter",
      model: "google/lyria-3-clip-preview",
      prompt: "score this image",
      cfg: {},
      format: "mp3",
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
    });

    expect(postRequest().body).toEqual(
      expect.objectContaining({
        model: "google/lyria-3-clip-preview",
        audio: { format: "mp3" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "score this image" },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
    );
  });

  it("times out stalled OpenRouter audio streams after headers", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: stalledSseResponse(
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { transcript: "start" } } }] })}\n`,
      ),
      release: vi.fn(async () => {}),
    });

    await expect(
      buildOpenRouterMusicGenerationProvider().generateMusic({
        provider: "openrouter",
        model: "google/lyria-3-clip-preview",
        prompt: "never finish",
        cfg: {},
        timeoutMs: 1,
      }),
    ).rejects.toThrow("OpenRouter music generation timed out after 1ms");
  });

  it("caps oversized OpenRouter music stream timeouts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      postJsonRequestMock.mockResolvedValue({
        response: sseResponse(["data: [DONE]\n"]),
        release: vi.fn(async () => {}),
      });

      await expect(
        buildOpenRouterMusicGenerationProvider().generateMusic({
          provider: "openrouter",
          model: "google/lyria-3-clip-preview",
          prompt: "huge timeout",
          cfg: {},
          timeoutMs: Number.MAX_SAFE_INTEGER,
        }),
      ).rejects.toThrow("OpenRouter music generation response missing audio data");

      expect(postRequest().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
      const streamTimeoutMs = timeoutSpy.mock.calls.at(-1)?.[1];
      expect(streamTimeoutMs).toBeGreaterThan(MAX_TIMER_TIMEOUT_MS - 1_000);
      expect(streamTimeoutMs).toBeLessThanOrEqual(MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects OpenRouter streams that end before completion", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from("partial").toString("base64") } } }] })}\n`,
      ]),
      release: vi.fn(async () => {}),
    });

    await expect(
      buildOpenRouterMusicGenerationProvider().generateMusic({
        provider: "openrouter",
        model: "google/lyria-3-clip-preview",
        prompt: "interrupted",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter music generation stream ended before completion");
  });

  it("surfaces and cancels OpenRouter mid-stream errors", async () => {
    const cancel = vi.fn();
    postJsonRequestMock.mockResolvedValue({
      response: sseResponse(
        [
          `data: ${JSON.stringify({
            error: { code: "provider_error", message: "provider disconnected" },
            choices: [{ delta: {}, finish_reason: "error" }],
          })}\n`,
        ],
        { cancel },
      ),
      release: vi.fn(async () => {}),
    });

    await expect(
      buildOpenRouterMusicGenerationProvider().generateMusic({
        provider: "openrouter",
        model: "google/lyria-3-clip-preview",
        prompt: "surface provider failure",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter music generation failed: provider disconnected");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts valid SSE events above the old fixed two-megabyte cap", async () => {
    const audio = Buffer.alloc(1_600_000, 0x61);
    postJsonRequestMock.mockResolvedValue({
      response: sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: audio.toString("base64") } } }] })}\n`,
        "data: [DONE]\n",
      ]),
      release: vi.fn(async () => {}),
    });

    const result = await buildOpenRouterMusicGenerationProvider().generateMusic({
      provider: "openrouter",
      model: "google/lyria-3-clip-preview",
      prompt: "large valid audio event",
      cfg: { agents: { defaults: { mediaMaxMb: 2 } } },
    });

    expect(result.tracks[0]?.buffer).toEqual(audio);
  });

  it("rejects OpenRouter music SSE events outside the configured media envelope", async () => {
    const maxBytes = 8;
    const maxEventBytes = Math.ceil(maxBytes / 3) * 4 + maxBytes + 64 * 1024;
    const cancel = vi.fn();
    postJsonRequestMock.mockResolvedValue({
      response: sseResponse([new Uint8Array(maxEventBytes + 1)], { cancel }),
      release: vi.fn(async () => {}),
    });

    await expect(
      buildOpenRouterMusicGenerationProvider().generateMusic({
        provider: "openrouter",
        model: "google/lyria-3-clip-preview",
        prompt: "unterminated event",
        cfg: { agents: { defaults: { mediaMaxMb: maxBytes / (1024 * 1024) } } },
      }),
    ).rejects.toThrow(
      `OpenRouter music generation SSE event exceeded ${maxEventBytes} bytes for a ${maxBytes}-byte media limit`,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "audio",
      delta: { audio: { data: Buffer.from("123456789").toString("base64") } },
    },
    {
      label: "transcript",
      delta: { audio: { transcript: "123456789" } },
    },
  ])("rejects $label beyond agents.defaults.mediaMaxMb", async ({ label, delta }) => {
    postJsonRequestMock.mockResolvedValue({
      response: sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n`,
        "data: [DONE]\n",
      ]),
      release: vi.fn(async () => {}),
    });

    await expect(
      buildOpenRouterMusicGenerationProvider().generateMusic({
        provider: "openrouter",
        model: "google/lyria-3-clip-preview",
        prompt: `oversized ${label}`,
        cfg: { agents: { defaults: { mediaMaxMb: 8 / (1024 * 1024) } } },
      }),
    ).rejects.toThrow(`OpenRouter music generation ${label} exceeded 8 bytes`);
  });
});
