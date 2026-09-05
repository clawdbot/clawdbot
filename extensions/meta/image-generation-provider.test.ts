// Meta tests cover the muse-image image-generation provider plugin behavior.
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMetaImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  resolveProviderHttpRequestConfigMock,
} = getProviderHttpMocks();

installProviderHttpMockCleanup();

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Meta returns base64 WebP payloads under data[].b64_json.
function mockGeneratedWebpResponse() {
  postJsonRequestMock.mockResolvedValue({
    response: jsonResponse({
      data: [{ b64_json: Buffer.from("webp-bytes").toString("base64") }],
    }),
    release: vi.fn(async () => {}),
  });
}

function mockEditedWebpResponse() {
  postMultipartRequestMock.mockResolvedValue({
    response: jsonResponse({
      data: [{ b64_json: Buffer.from("webp-bytes").toString("base64") }],
    }),
    release: vi.fn(async () => {}),
  });
}

function mockObjectArg(mock: unknown, index = -1): Record<string, unknown> {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = index < 0 ? calls.at(index) : calls[index];
  const [arg] = call ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected mock object argument ${index}`);
  }
  return arg as Record<string, unknown>;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("meta image generation provider", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "meta-key" });
  });

  it("declares the meta id and muse-image catalog surface", () => {
    const provider = buildMetaImageGenerationProvider();

    expect(provider.id).toBe("meta");
    expect(provider.label).toBe("Meta");
    expect(provider.defaultModel).toBe("muse-image-1.0");
    expect(provider.models).toContain("muse-image-1.0");
    expect(provider.capabilities.geometry?.sizes).toContain("1024x1024");
    // muse-image supports single-reference edits via /v1/images/edits.
    expect(provider.capabilities.edit?.enabled).toBe(true);
    expect(provider.capabilities.edit?.maxInputImages).toBe(1);
  });

  it("defaults to the Meta base URL and posts to /images/generations", async () => {
    mockGeneratedWebpResponse();

    const provider = buildMetaImageGenerationProvider();
    await provider.generateImage({
      provider: "meta",
      model: "muse-image-1.0",
      prompt: "a single ripe banana on a white background",
      cfg: {},
    });

    expectFields(mockObjectArg(resolveProviderHttpRequestConfigMock), {
      baseUrl: "https://api.meta.ai/v1",
    });
    expect(mockObjectArg(postJsonRequestMock).url).toBe(
      "https://api.meta.ai/v1/images/generations",
    );
  });

  it("sends the requested model, prompt, and defaults in the generate body", async () => {
    mockGeneratedWebpResponse();

    const provider = buildMetaImageGenerationProvider();
    await provider.generateImage({
      provider: "meta",
      model: "muse-image-1.0",
      prompt: "a lighthouse",
      cfg: {},
    });

    expectFields(mockObjectArg(postJsonRequestMock).body as Record<string, unknown>, {
      model: "muse-image-1.0",
      prompt: "a lighthouse",
      n: 1,
      size: "1024x1024",
    });
  });

  it("honors a configured baseUrl override", async () => {
    mockGeneratedWebpResponse();

    const provider = buildMetaImageGenerationProvider();
    await provider.generateImage({
      provider: "meta",
      model: "muse-image-1.0",
      prompt: "campaign hero",
      cfg: {
        models: {
          providers: {
            meta: { baseUrl: "https://api.meta.ai/v1/", models: [] },
          },
        },
      },
    });

    expect(mockObjectArg(postJsonRequestMock).url).toBe(
      "https://api.meta.ai/v1/images/generations",
    );
  });

  it("forwards the requested size and count", async () => {
    mockGeneratedWebpResponse();

    const provider = buildMetaImageGenerationProvider();
    await provider.generateImage({
      provider: "meta",
      model: "muse-image-1.0",
      prompt: "portrait render",
      cfg: {},
      size: "1024x1536",
    });

    expectFields(mockObjectArg(postJsonRequestMock).body as Record<string, unknown>, {
      model: "muse-image-1.0",
      prompt: "portrait render",
      size: "1024x1536",
    });
  });

  it("routes to the multipart /images/edits endpoint when a reference image is provided", async () => {
    mockEditedWebpResponse();

    const provider = buildMetaImageGenerationProvider();
    await provider.generateImage({
      provider: "meta",
      model: "muse-image-1.0",
      prompt: "change the cube color to blue",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("fake-input"), mimeType: "image/webp" }],
    });

    // Edits must be multipart against /images/edits, never JSON.
    expect(postJsonRequestMock).not.toHaveBeenCalled();
    expect(mockObjectArg(postMultipartRequestMock).url).toBe("https://api.meta.ai/v1/images/edits");

    const form = mockObjectArg(postMultipartRequestMock).body as FormData;
    expect(form.get("model")).toBe("muse-image-1.0");
    expect(form.get("prompt")).toBe("change the cube color to blue");
    expect(form.getAll("image")).toHaveLength(1);
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("throws a clear error when the API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });

    const provider = buildMetaImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "meta",
        model: "muse-image-1.0",
        prompt: "x",
        cfg: {},
      }),
    ).rejects.toThrow("Meta API key missing");
  });
});
