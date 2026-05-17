import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
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

describe("openrouter music generation provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
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
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: audioBase64.slice(0, 4) } } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: audioBase64.slice(4), transcript: "two" } } }] })}\n`,
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
});
