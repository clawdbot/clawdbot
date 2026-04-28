import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAiCompatibleImageGenerationProvider,
  type OpenAiCompatibleImageProviderOptions,
} from "./openai-compatible-image-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  createProviderOperationDeadlineMock,
  isProviderApiKeyConfiguredMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequestMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  createProviderOperationDeadlineMock: vi.fn((params: Record<string, unknown>) => ({
    timeoutMs: params.timeoutMs,
    label: params.label,
  })),
  isProviderApiKeyConfiguredMock: vi.fn(() => true),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => {
    const request =
      typeof params.request === "object" && params.request !== null
        ? (params.request as Record<string, unknown>)
        : undefined;
    return {
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: Boolean(params.allowPrivateNetwork ?? request?.allowPrivateNetwork),
      headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
      dispatcherPolicy: request ? { request } : undefined,
    };
  }),
  resolveProviderOperationTimeoutMsMock: vi.fn(
    (params: Record<string, unknown>) => params.defaultTimeoutMs,
  ),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
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
  sanitizeConfiguredModelProviderRequest: sanitizeConfiguredModelProviderRequestMock,
}));

function createProvider(overrides: Partial<OpenAiCompatibleImageProviderOptions> = {}) {
  return createOpenAiCompatibleImageGenerationProvider({
    id: "sample",
    label: "Sample",
    defaultModel: "sample-image",
    models: ["sample-image"],
    defaultBaseUrl: "https://sample.example/v1",
    capabilities: {
      generate: { maxCount: 4, supportsSize: true },
      edit: { enabled: true, maxCount: 1, maxInputImages: 1, supportsSize: true },
      geometry: { sizes: ["1024x1024"] },
    },
    useConfiguredRequest: true,
    buildGenerateRequest: ({ req, model, count }) => ({
      kind: "json",
      body: {
        model,
        prompt: req.prompt,
        n: count,
        size: req.size ?? "1024x1024",
        response_format: "b64_json",
      },
    }),
    buildEditRequest: ({ req, inputImages, model, count }) => {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", req.prompt);
      form.set("n", String(count));
      form.append(
        "image",
        new Blob([new Uint8Array(inputImages[0]?.buffer ?? Buffer.alloc(0))], {
          type: inputImages[0]?.mimeType ?? "image/png",
        }),
        inputImages[0]?.fileName ?? "image.png",
      );
      return { kind: "multipart", form };
    },
    ...overrides,
  });
}

function mockGeneratedResponse() {
  const release = vi.fn(async () => {});
  const payload = {
    data: [
      {
        b64_json: Buffer.from("image-bytes").toString("base64"),
        revised_prompt: "revised",
      },
    ],
  };
  postJsonRequestMock.mockResolvedValue({ response: { json: async () => payload }, release });
  postMultipartRequestMock.mockResolvedValue({ response: { json: async () => payload }, release });
  return release;
}

describe("OpenAI-compatible image provider helper", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    createProviderOperationDeadlineMock.mockClear();
    isProviderApiKeyConfiguredMock.mockClear();
    postJsonRequestMock.mockReset();
    postMultipartRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "provider-key" });
    resolveProviderHttpRequestConfigMock.mockClear();
    resolveProviderOperationTimeoutMsMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
  });

  it("builds provider metadata and delegates configuration checks", () => {
    const provider = createProvider();

    expect(provider.id).toBe("sample");
    expect(provider.label).toBe("Sample");
    expect(provider.defaultModel).toBe("sample-image");
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(true);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "sample",
      agentDir: "/tmp/agent",
    });
  });

  it("posts JSON generation requests and parses OpenAI-compatible image data", async () => {
    const release = mockGeneratedResponse();
    const provider = createProvider();

    const result = await provider.generateImage({
      provider: "sample",
      model: "custom-image",
      prompt: "draw a square",
      count: 2,
      size: "512x512",
      cfg: {
        models: {
          providers: {
            sample: {
              baseUrl: "https://sample.example/v1/",
              request: { allowPrivateNetwork: true },
            },
          },
        },
      },
    } as never);

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "sample" }),
    );
    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith({
      allowPrivateNetwork: true,
    });
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://sample.example/v1/images/generations",
        allowPrivateNetwork: true,
        dispatcherPolicy: { request: { allowPrivateNetwork: true } },
        body: {
          model: "custom-image",
          prompt: "draw a square",
          n: 2,
          size: "512x512",
          response_format: "b64_json",
        },
      }),
    );
    const headers = postJsonRequestMock.mock.calls[0]?.[0].headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(result).toMatchObject({
      model: "custom-image",
      images: [{ mimeType: "image/png", fileName: "image-1.png", revisedPrompt: "revised" }],
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("posts multipart edit requests without forwarding a content-type header", async () => {
    mockGeneratedResponse();
    const provider = createProvider();

    await provider.generateImage({
      provider: "sample",
      model: "sample-image",
      prompt: "edit it",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
      cfg: {} as never,
    });

    expect(postMultipartRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://sample.example/v1/images/edits",
        body: expect.any(FormData),
      }),
    );
    const headers = postMultipartRequestMock.mock.calls[0]?.[0].headers as Headers;
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("honors default operation timeouts and empty-response errors", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: { json: async () => ({ data: [] }) },
      release: vi.fn(async () => {}),
    });
    const provider = createProvider({
      defaultTimeoutMs: 60_000,
      emptyResponseError: "Sample response missing image data",
    });

    await expect(
      provider.generateImage({
        provider: "sample",
        model: "sample-image",
        prompt: "empty",
        timeoutMs: 123,
        cfg: {} as never,
      }),
    ).rejects.toThrow("Sample response missing image data");

    expect(createProviderOperationDeadlineMock).toHaveBeenCalledWith({
      timeoutMs: 123,
      label: "Sample image generation",
    });
    expect(resolveProviderOperationTimeoutMsMock).toHaveBeenCalledWith({
      deadline: { timeoutMs: 123, label: "Sample image generation" },
      defaultTimeoutMs: 60_000,
    });
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });
});
