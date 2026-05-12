import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.resetModules();
});

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

function requireFirstMockObjectArg(mock: ReturnType<typeof vi.fn>, label: string): object {
  const value = requireFirstMockArg(mock, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

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

    expect(resolveProviderHttpRequestConfigMock.mock.calls).toEqual([
      [
        {
          baseUrl: "https://api.deepinfra.com/v1/openai",
          defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
          allowPrivateNetwork: false,
          request: undefined,
          defaultHeaders: {
            Authorization: "Bearer deepinfra-key",
          },
          provider: "deepinfra",
          capability: "image",
          transport: "http",
        },
      ],
    ]);
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const jsonRequest = requireFirstMockArg(postJsonRequestMock, "DeepInfra JSON image request");
    const jsonRequestHeaders = Reflect.get(jsonRequest ?? {}, "headers");
    expect(jsonRequestHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((jsonRequestHeaders as Headers).entries())).toEqual({
      authorization: "Bearer deepinfra-key",
      "content-type": "application/json",
    });
    expect(jsonRequest).toEqual({
      url: "https://api.deepinfra.com/v1/openai/images/generations",
      headers: jsonRequestHeaders,
      timeoutMs: 12_345,
      body: {
        model: "black-forest-labs/FLUX-1-schnell",
        prompt: "red square",
        n: 2,
        size: "512x512",
        response_format: "b64_json",
      },
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });
    expect(result.images).toHaveLength(1);
    const [firstImage] = result.images;
    if (!firstImage) {
      throw new Error("Expected generated DeepInfra image");
    }
    expect(firstImage).toEqual({
      buffer: jpegBytes,
      mimeType: "image/jpeg",
      fileName: "image-1.jpg",
      revisedPrompt: "red square",
    });
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

    expect(postMultipartRequestMock).toHaveBeenCalledOnce();
    const multipartRequest = requireFirstMockObjectArg(
      postMultipartRequestMock,
      "DeepInfra multipart image request",
    );
    const multipartHeaders = Reflect.get(multipartRequest, "headers");
    expect(multipartHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((multipartHeaders as Headers).entries())).toEqual({
      authorization: "Bearer deepinfra-key",
    });
    const form = Reflect.get(multipartRequest, "body") as FormData;
    expect(multipartRequest).toEqual({
      url: "https://api.deepinfra.com/v1/openai/images/edits",
      headers: multipartHeaders,
      body: form,
      timeoutMs: undefined,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });
    expect(form.get("model")).toBe("black-forest-labs/FLUX-1-schnell");
    expect(form.get("prompt")).toBe("make it neon");
    expect(form.get("response_format")).toBe("b64_json");
    expect(form.get("image")).toBeInstanceOf(File);
    expect(result.images).toHaveLength(1);
    const [image] = result.images;
    if (!image) {
      throw new Error("Expected edited DeepInfra image");
    }
    expect(image.mimeType).toBe("image/png");
  });
});
