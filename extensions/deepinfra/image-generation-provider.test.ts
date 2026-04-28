import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDeepInfraImageGenerationProvider } from "./image-generation-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  createProviderOperationDeadlineMock,
  resolveProviderOperationTimeoutMsMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "deepinfra-key" })),
  createProviderOperationDeadlineMock: vi.fn((params: Record<string, unknown>) => params),
  resolveProviderOperationTimeoutMsMock: vi.fn(
    (params: Record<string, unknown>) => params.defaultTimeoutMs,
  ),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://api.deepinfra.com/v1/openai",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  createProviderOperationDeadline: createProviderOperationDeadlineMock,
  postJsonRequest: postJsonRequestMock,
  postMultipartRequest: postMultipartRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  resolveProviderOperationTimeoutMs: resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequest: vi.fn((request) => request),
}));

describe("deepinfra image generation provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    postMultipartRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("declares generation and single-reference edit support", () => {
    const provider = buildDeepInfraImageGenerationProvider();

    expect(provider.id).toBe("deepinfra");
    expect(provider.defaultModel).toBe("black-forest-labs/FLUX-1-schnell");
    expect(provider.capabilities.generate.maxCount).toBe(4);
    expect(provider.capabilities.edit.enabled).toBe(true);
    expect(provider.capabilities.edit.maxInputImages).toBe(1);
  });

  it("sends OpenAI-compatible image generation requests and sniffs JPEG output", async () => {
    const release = vi.fn(async () => {});
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{ b64_json: jpegBytes.toString("base64"), revised_prompt: "red square" }],
        }),
      },
      release,
    });

    const provider = buildDeepInfraImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "deepinfra",
      model: "deepinfra/black-forest-labs/FLUX-1-schnell",
      prompt: "red square",
      count: 2,
      size: "512x512",
      timeoutMs: 12_345,
      cfg: {
        models: {
          providers: {
            deepinfra: {
              baseUrl: "https://api.deepinfra.com/v1/openai/",
            },
          },
        },
      } as never,
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepinfra",
        capability: "image",
        baseUrl: "https://api.deepinfra.com/v1/openai",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.deepinfra.com/v1/openai/images/generations",
        timeoutMs: 12_345,
        body: {
          model: "black-forest-labs/FLUX-1-schnell",
          prompt: "red square",
          n: 2,
          size: "512x512",
          response_format: "b64_json",
        },
      }),
    );
    expect(result.images[0]?.mimeType).toBe("image/jpeg");
    expect(result.images[0]?.fileName).toBe("image-1.jpg");
    expect(result.images[0]?.revisedPrompt).toBe("red square");
    expect(release).toHaveBeenCalledOnce();
  });

  it("sends image edits as multipart OpenAI-compatible requests", async () => {
    postMultipartRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [
            {
              b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
                "base64",
              ),
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildDeepInfraImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "deepinfra",
      model: "black-forest-labs/FLUX-1-schnell",
      prompt: "make it neon",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
      cfg: {} as never,
    });

    expect(postMultipartRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.deepinfra.com/v1/openai/images/edits",
      }),
    );
    const form = postMultipartRequestMock.mock.calls[0]?.[0].body as FormData;
    expect(form.get("model")).toBe("black-forest-labs/FLUX-1-schnell");
    expect(form.get("prompt")).toBe("make it neon");
    expect(form.get("response_format")).toBe("b64_json");
    expect(form.get("image")).toBeInstanceOf(File);
    expect(result.images[0]?.mimeType).toBe("image/png");
  });
});
