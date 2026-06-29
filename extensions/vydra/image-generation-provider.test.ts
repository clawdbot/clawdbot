// Vydra tests cover image generation provider plugin behavior.
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVydraImageGenerationProvider } from "./image-generation-provider.js";
import {
  binaryResponse,
  jsonResponse,
  stubFetch,
  stubVydraApiKey,
} from "./provider-test-helpers.test.js";

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected fetch call ${index}`);
  }
  return call as [string, RequestInit];
}

function oversizedJsonResponse(): Response {
  return new Response(Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("vydra image-generation provider", () => {
  installPinnedHostnameTestHooks();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts to the www api and downloads the generated image", async () => {
    stubVydraApiKey();
    const fetchMock = stubFetch(
      jsonResponse({
        jobId: "job-123",
        status: "completed",
        imageUrl: "https://cdn.vydra.ai/generated/test.png",
      }),
      binaryResponse("png-data", "image/png"),
    );

    const provider = buildVydraImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "vydra",
      model: "grok-imagine",
      prompt: "draw a cat",
      cfg: {},
    });

    const createCall = fetchCall(fetchMock);
    expect(createCall[0]).toBe("https://www.vydra.ai/api/v1/models/grok-imagine");
    expect(createCall[1].method).toBe("POST");
    expect(createCall[1].body).toBe(
      JSON.stringify({
        prompt: "draw a cat",
        model: "text-to-image",
      }),
    );
    const headers = new Headers(createCall[1].headers);
    expect(headers.get("authorization")).toBe("Bearer vydra-test-key");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "grok-imagine",
      metadata: {
        jobId: "job-123",
        imageUrl: "https://cdn.vydra.ai/generated/test.png",
        status: "completed",
      },
    });
  });

  it("rejects generated image downloads that exceed the configured media cap", async () => {
    stubVydraApiKey();
    stubFetch(
      jsonResponse({
        jobId: "job-123",
        status: "completed",
        imageUrl: "https://cdn.vydra.ai/generated/test.png",
      }),
      binaryResponse("too-large", "image/png"),
    );

    const provider = buildVydraImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "vydra",
        model: "grok-imagine",
        prompt: "draw a cat",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("Vydra image download exceeds 1 bytes");
  });

  it("rejects image creation JSON responses that exceed the provider cap", async () => {
    stubVydraApiKey();
    stubFetch(oversizedJsonResponse());

    const provider = buildVydraImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "vydra",
        model: "grok-imagine",
        prompt: "draw a cat",
        cfg: {},
      }),
    ).rejects.toThrow("vydra.image-generation: JSON response exceeds 16777216 bytes");
  });

  it("passes request SSRF policy to the image creation request", async () => {
    stubVydraApiKey();
    const fetchMock = stubFetch(
      jsonResponse({
        jobId: "job-123",
        status: "completed",
        imageUrl: "https://cdn.vydra.ai/generated/test.png",
      }),
      binaryResponse("png-data", "image/png"),
    );

    const provider = buildVydraImageGenerationProvider();
    await provider.generateImage({
      provider: "vydra",
      model: "grok-imagine",
      prompt: "draw a cat",
      cfg: {
        models: {
          providers: {
            vydra: {
              baseUrl: "https://198.18.0.10/api/v1",
            },
          },
        },
      } as never,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    const createCall = fetchCall(fetchMock);
    expect(createCall[0]).toBe("https://198.18.0.10/api/v1/models/grok-imagine");
    expect(createCall[1].method).toBe("POST");
  });

  it("polls jobs when the create response is not completed yet", async () => {
    stubVydraApiKey();
    const fetchMock = stubFetch(
      jsonResponse({ jobId: "job-456", status: "queued" }),
      jsonResponse({
        jobId: "job-456",
        status: "completed",
        resultUrls: ["https://cdn.vydra.ai/generated/polled.png"],
      }),
      binaryResponse("png-data", "image/png"),
    );

    const provider = buildVydraImageGenerationProvider();
    await provider.generateImage({
      provider: "vydra",
      model: "grok-imagine",
      prompt: "draw a cat",
      cfg: {},
    });

    const pollCall = fetchCall(fetchMock, 1);
    expect(pollCall[0]).toBe("https://www.vydra.ai/api/v1/jobs/job-456");
    expect(pollCall[1].method).toBe("GET");
  });

  it("rejects job poll JSON responses that exceed the provider cap", async () => {
    stubVydraApiKey();
    stubFetch(jsonResponse({ jobId: "job-456", status: "queued" }), oversizedJsonResponse());

    const provider = buildVydraImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "vydra",
        model: "grok-imagine",
        prompt: "draw a cat",
        cfg: {},
      }),
    ).rejects.toThrow("Vydra job status: JSON response exceeds 16777216 bytes");
  });
});
