import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHuggingfaceImageGenerationProvider } from "./image-generation-provider.js";

installPinnedHostnameTestHooks();

const HF_INFERENCE_BASE = "https://router.huggingface.co/hf-inference";

describe("huggingface image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function mockHuggingfaceApiKey(apiKey = "hf_test_token") {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey,
      source: "env",
      mode: "api-key",
    });
  }

  function mockSuccessfulImageResponse(bytes = Buffer.from("png-bytes")) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts raw bytes through the hf-inference router for the default model", async () => {
    mockHuggingfaceApiKey();
    const fetchMock = mockSuccessfulImageResponse();

    const provider = buildHuggingfaceImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "huggingface",
      model: "",
      prompt: "draw a cat",
      cfg: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${HF_INFERENCE_BASE}/models/black-forest-labs/FLUX.1-schnell`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ inputs: "draw a cat" }));

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer hf_test_token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("image/*");

    expect(result.model).toBe("black-forest-labs/FLUX.1-schnell");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.images[0]?.fileName).toBe("image-1.png");
    expect(result.images[0]?.buffer.toString()).toBe("png-bytes");
  });

  it("forwards the requested model and width/height parameters", async () => {
    mockHuggingfaceApiKey();
    const fetchMock = mockSuccessfulImageResponse();

    const provider = buildHuggingfaceImageGenerationProvider();
    await provider.generateImage({
      provider: "huggingface",
      model: "Qwen/Qwen-Image",
      prompt: "draw a cat",
      cfg: {},
      size: "1024x768",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${HF_INFERENCE_BASE}/models/Qwen/Qwen-Image`);
    expect(init.body).toBe(
      JSON.stringify({
        inputs: "draw a cat",
        parameters: { width: 1024, height: 768 },
      }),
    );
  });

  it("infers JPEG mime/extension from the response Content-Type", async () => {
    mockHuggingfaceApiKey();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from("jpeg-bytes"), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildHuggingfaceImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "huggingface",
      model: "",
      prompt: "draw a cat",
      cfg: {},
    });

    expect(result.images[0]?.mimeType).toBe("image/jpeg");
    expect(result.images[0]?.fileName).toBe("image-1.jpg");
  });

  it("rejects requests when no Hugging Face API key resolves", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: undefined,
      source: "missing",
      mode: "api-key",
    });

    const provider = buildHuggingfaceImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "huggingface",
        model: "",
        prompt: "draw a cat",
        cfg: {},
      }),
    ).rejects.toThrow(/Hugging Face API key missing/);
  });

  it("surfaces upstream HTTP errors", async () => {
    mockHuggingfaceApiKey();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Unauthorized", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildHuggingfaceImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "huggingface",
        model: "",
        prompt: "draw a cat",
        cfg: {},
      }),
    ).rejects.toThrow(/Hugging Face image generation failed/);
  });

  it("rejects empty image payloads from the inference router", async () => {
    mockHuggingfaceApiKey();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.alloc(0), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildHuggingfaceImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "huggingface",
        model: "",
        prompt: "draw a cat",
        cfg: {},
      }),
    ).rejects.toThrow(/returned no image data/);
  });

  it.each([
    ["multi-segment traversal", "../../admin"],
    ["single-segment traversal as org", "../foo"],
    ["single-segment traversal as repo", "foo/.."],
    ["leading dot in repo", "foo/.bar"],
    ["leading slash", "/foo/bar"],
    ["missing repo segment", "foo"],
    ["empty org", "/foo"],
    ["empty repo", "foo/"],
  ])("rejects model id with %s (%s)", async (_label, model) => {
    mockHuggingfaceApiKey();
    const fetchMock = mockSuccessfulImageResponse();

    const provider = buildHuggingfaceImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "huggingface",
        model,
        prompt: "draw a cat",
        cfg: {},
      }),
    ).rejects.toThrow(/Invalid Hugging Face model id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests that carry input images (edit is unsupported)", async () => {
    mockHuggingfaceApiKey();
    const fetchMock = mockSuccessfulImageResponse();

    const provider = buildHuggingfaceImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "huggingface",
        model: "",
        prompt: "draw a cat",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow(/does not support input images/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests for more than one image (capability is single-image)", async () => {
    mockHuggingfaceApiKey();
    const fetchMock = mockSuccessfulImageResponse();

    const provider = buildHuggingfaceImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "huggingface",
        model: "",
        prompt: "draw a cat",
        cfg: {},
        count: 2,
      }),
    ).rejects.toThrow(/single image per request/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declares the hf-inference text-to-image capability surface", () => {
    const provider = buildHuggingfaceImageGenerationProvider();
    expect(provider.id).toBe("huggingface");
    expect(provider.defaultModel).toBe("black-forest-labs/FLUX.1-schnell");
    expect(provider.capabilities.generate.maxCount).toBe(1);
    expect(provider.capabilities.edit.enabled).toBe(false);
  });
});
