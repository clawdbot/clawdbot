import { afterEach, describe, expect, it, vi } from "vitest";
import { buildXaiImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  isProviderApiKeyConfiguredMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
  createProviderOperationDeadlineMock,
  resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequestMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "xai-key" })),
  isProviderApiKeyConfiguredMock: vi.fn(() => true),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://api.x.ai/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
  createProviderOperationDeadlineMock: vi.fn((params: Record<string, unknown>) => ({
    timeoutMs: params.timeoutMs,
    label: params.label,
  })),
  resolveProviderOperationTimeoutMsMock: vi.fn(
    (params: Record<string, unknown>) => params.defaultTimeoutMs ?? 60000,
  ),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
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

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", () => ({
  normalizeOptionalString: (v: unknown) => (typeof v === "string" ? v.trim() : undefined),
  normalizeOptionalLowercaseString: (v: unknown) =>
    typeof v === "string" ? v.trim().toLowerCase() : undefined,
  readStringValue: (v: unknown) => (typeof v === "string" ? v.trim() : undefined),
}));

function requirePostJsonCall(index = 0): {
  url?: string;
  timeoutMs?: number;
  body?: Record<string, unknown>;
} {
  const params = (postJsonRequestMock.mock.calls as unknown as Array<[unknown]>)[index]?.[0] as
    | {
        url?: string;
        timeoutMs?: number;
        body?: Record<string, unknown>;
      }
    | undefined;
  if (!params) {
    throw new Error(`Expected postJsonRequest call ${index}`);
  }
  return params;
}

describe("xai image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    isProviderApiKeyConfiguredMock.mockClear();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    createProviderOperationDeadlineMock.mockClear();
    resolveProviderOperationTimeoutMsMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
  });

  it("builds provider with correct models, default, and capabilities", () => {
    const provider = buildXaiImageGenerationProvider();
    expect(provider.id).toBe("xai");
    expect(provider.label).toBe("xAI");
    expect(provider.defaultModel).toBe("grok-imagine-image");
    expect(provider.models).toEqual(["grok-imagine-image", "grok-imagine-image-pro"]);
    expect(provider.capabilities.generate.maxCount).toBe(4);
    expect(provider.capabilities.generate.supportsAspectRatio).toBe(true);
    expect(provider.capabilities.geometry?.aspectRatios).toEqual([
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4",
      "2:3",
      "3:2",
    ]);
    expect(provider.capabilities.edit.enabled).toBe(true);
    expect(provider.capabilities.edit.maxInputImages).toBe(5);
    const isConfigured = provider.isConfigured;
    if (!isConfigured) {
      throw new Error("expected XAI image provider config predicate");
    }
    expect(isConfigured({ agentDir: "/tmp/openclaw-xai-test" })).toBe(true);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "xai",
      agentDir: "/tmp/openclaw-xai-test",
    });
  });

  it("uses main provider URL and resolves auth for generation", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{ b64_json: Buffer.from("testpng").toString("base64") }],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildXaiImageGenerationProvider();
    await provider.generateImage({
      provider: "xai",
      model: "grok-imagine-image",
      prompt: "test prompt",
      aspectRatio: "2:3",
      resolution: "2K",
      cfg: {
        models: {
          providers: {
            xai: {
              baseUrl: "https://custom.x.ai/v1",
            },
          },
        },
      },
    } as any);

    const authParams = (
      resolveApiKeyForProviderMock.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0] as { provider?: string } | undefined;
    expect(authParams?.provider).toBe("xai");
    const httpParams = (
      resolveProviderHttpRequestConfigMock.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0] as
      | {
          provider?: string;
          capability?: string;
          baseUrl?: string;
        }
      | undefined;
    expect(httpParams?.provider).toBe("xai");
    expect(httpParams?.capability).toBe("image");
    expect(httpParams?.baseUrl).toBe("https://custom.x.ai/v1");
    const request = requirePostJsonCall();
    expect(request.url).toContain("/images/generations");
    expect(request.timeoutMs).toBe(180_000);
    expect(request.body?.aspect_ratio).toBe("2:3");
    expect(request.body?.resolution).toBe("2k");
  });

  it("supports edit with exact user-provided payload format including image object with type image_url", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [
            {
              b64_json:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4z0ABAAEfAG0B0xMAAAAASUVORK5CYII=",
              mime_type: "image/png",
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildXaiImageGenerationProvider();
    const buffer = Buffer.from("fakeimage");
    await provider.generateImage({
      provider: "xai",
      model: "grok-imagine-image-pro",
      prompt: "Render this as a pencil sketch with detailed shading",
      inputImages: [
        {
          buffer,
          mimeType: "image/png",
        },
      ],
      cfg: {},
    } as any);

    const request = requirePostJsonCall();
    expect(request.url).toContain("/images/edits");
    expect(request.body?.model).toBe("grok-imagine-image-pro");
    expect(request.body?.prompt).toBe("Render this as a pencil sketch with detailed shading");
    const image = request.body?.image as { url?: string; type?: string } | undefined;
    expect(image?.url).toContain("data:image/png;base64,");
    expect(image?.type).toBe("image_url");
    expect(request.body?.response_format).toBe("b64_json");
  });

  it("uses the plural xAI images payload for multiple edit inputs", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [
            {
              b64_json: Buffer.from("edited").toString("base64"),
              mime_type: "image/png",
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildXaiImageGenerationProvider();
    await provider.generateImage({
      provider: "xai",
      model: "grok-imagine-image",
      prompt: "Combine the references",
      inputImages: [
        { buffer: Buffer.from("first"), mimeType: "image/png" },
        { buffer: Buffer.from("second"), mimeType: "image/jpeg" },
      ],
      cfg: {},
    } as any);

    const request = requirePostJsonCall();
    expect(request.url).toContain("/images/edits");
    const images = request.body?.images as Array<{ url?: string; type?: string }> | undefined;
    expect(images).toHaveLength(2);
    expect(images?.[0]?.url).toContain("data:image/png;base64,");
    expect(images?.[0]?.type).toBe("image_url");
    expect(images?.[1]?.url).toContain("data:image/jpeg;base64,");
    expect(images?.[1]?.type).toBe("image_url");
  });
});
