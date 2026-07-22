// Vydra tests cover video generation provider plugin behavior.
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  binaryResponse,
  jsonResponse,
  stubFetch,
  stubVydraApiKey,
} from "./provider-test-helpers.test.js";
import { buildVydraVideoGenerationProvider } from "./video-generation-provider.js";

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index}`);
  }
  return call;
}

function oversizedJsonResponse(): Response {
  return new Response(Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("vydra video-generation provider", () => {
  installPinnedHostnameTestHooks();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildVydraVideoGenerationProvider());
  });

  it("submits veo3 jobs and downloads the completed video", async () => {
    stubVydraApiKey();
    const fetchMock = stubFetch(
      jsonResponse({ jobId: "job-123", status: "processing" }),
      jsonResponse({
        jobId: "job-123",
        status: "completed",
        videoUrl: "https://cdn.vydra.ai/generated/test.mp4",
      }),
      binaryResponse("webm-data", "video/webm"),
    );

    const provider = buildVydraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "vydra",
      model: "veo3",
      prompt: "tiny city at sunrise",
      cfg: {},
    });

    const createCall = fetchCall(fetchMock, 0);
    expect(createCall[0]).toBe("https://www.vydra.ai/api/v1/models/veo3");
    const createInit = createCall[1] as { method?: string; body?: unknown } | undefined;
    expect(createInit?.method).toBe("POST");
    expect(createInit?.body).toBe(JSON.stringify({ prompt: "tiny city at sunrise" }));
    const pollCall = fetchCall(fetchMock, 1);
    expect(pollCall[0]).toBe("https://www.vydra.ai/api/v1/jobs/job-123");
    const pollInit = pollCall[1] as { method?: string } | undefined;
    expect(pollInit?.method).toBe("GET");
    expect(result.videos).toHaveLength(1);
    const [video] = result.videos;
    if (!video) {
      throw new Error("Expected generated Vydra video");
    }
    expect(video.mimeType).toBe("video/webm");
    expect(video.fileName).toBe("video-1.webm");
    expect(result.metadata).toEqual({
      jobId: "job-123",
      videoUrl: "https://cdn.vydra.ai/generated/test.mp4",
      status: "completed",
    });
  });

  it("carries configured request policy through video submit, poll, and download", async () => {
    stubVydraApiKey();
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest");
    const pollProviderOperationJsonSpy = vi.spyOn(providerHttp, "pollProviderOperationJson");
    const fetchWithTimeoutGuardedSpy = vi.spyOn(providerHttp, "fetchWithTimeoutGuarded");
    const fetchMock = stubFetch(
      jsonResponse({ jobId: "job-policy", status: "processing" }),
      jsonResponse({
        jobId: "job-policy",
        status: "completed",
        videoUrl: "https://198.18.0.10/generated/policy.mp4",
      }),
      binaryResponse("mp4-data", "video/mp4"),
    );

    const provider = buildVydraVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vydra",
      model: "veo3",
      prompt: "policy proof",
      cfg: {
        models: {
          providers: {
            vydra: {
              baseUrl: "https://198.18.0.10/api/v1",
              models: [],
              request: {
                allowPrivateNetwork: true,
                headers: { "X-Vydra-Policy": "video-policy" },
                proxy: { mode: "env-proxy" },
              },
            },
          },
        },
      },
    });

    const submitRequest = postJsonRequestSpy.mock.calls[0]?.[0];
    expect(submitRequest?.allowPrivateNetwork).toBe(true);
    expect(submitRequest?.dispatcherPolicy).toMatchObject({ mode: "env-proxy" });
    expect(submitRequest?.headers.get("x-vydra-policy")).toBe("video-policy");

    const pollRequest = pollProviderOperationJsonSpy.mock.calls[0]?.[0];
    expect(pollRequest?.allowPrivateNetwork).toBe(true);
    expect(pollRequest?.dispatcherPolicy).toBe(submitRequest?.dispatcherPolicy);
    const pollHeaders = new Headers(
      typeof pollRequest?.headers === "function" ? pollRequest.headers() : pollRequest?.headers,
    );
    expect(pollHeaders.get("x-vydra-policy")).toBe("video-policy");

    const downloadRequest = fetchWithTimeoutGuardedSpy.mock.calls.find(
      ([url]) => url === "https://198.18.0.10/generated/policy.mp4",
    );
    expect(downloadRequest?.[4]).toMatchObject({
      ssrfPolicy: { allowPrivateNetwork: true },
      dispatcherPolicy: submitRequest?.dispatcherPolicy,
      auditContext: "vydra-media-download",
    });

    for (const index of [0, 1, 2]) {
      const headers = new Headers((fetchCall(fetchMock, index)[1] as RequestInit).headers);
      expect(headers.get("authorization")).toBe("Bearer vydra-test-key");
      expect(headers.get("x-vydra-policy")).toBe("video-policy");
    }
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    stubVydraApiKey();
    stubFetch(
      jsonResponse({ jobId: "job-123", status: "processing" }),
      jsonResponse({
        jobId: "job-123",
        status: "completed",
        videoUrl: "https://cdn.vydra.ai/generated/test.mp4",
      }),
      binaryResponse("too-large", "video/mp4"),
    );

    const provider = buildVydraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "vydra",
        model: "veo3",
        prompt: "tiny city at sunrise",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("Vydra video download exceeds 1 bytes");
  });

  it("rejects video creation JSON responses that exceed the provider cap", async () => {
    stubVydraApiKey();
    stubFetch(oversizedJsonResponse());

    const provider = buildVydraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "vydra",
        model: "veo3",
        prompt: "tiny city at sunrise",
        cfg: {},
      }),
    ).rejects.toThrow("Vydra video generation: JSON response exceeds 16777216 bytes");
  });

  it("requires a remote image url for kling", async () => {
    stubVydraApiKey();
    vi.stubGlobal("fetch", vi.fn());

    const provider = buildVydraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "vydra",
        model: "kling",
        prompt: "animate this image",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("Vydra kling currently requires a remote image URL reference.");
  });

  it("submits kling jobs with a remote image url", async () => {
    stubVydraApiKey();
    const fetchMock = stubFetch(
      jsonResponse({ jobId: "job-kling", status: "processing" }),
      jsonResponse({
        jobId: "job-kling",
        status: "completed",
        videoUrl: "https://cdn.vydra.ai/generated/kling.mp4",
      }),
      binaryResponse("mp4-data", "video/mp4"),
    );

    const provider = buildVydraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "vydra",
      model: "kling",
      prompt: "animate this image",
      cfg: {},
      inputImages: [{ url: "https://example.com/reference.png" }],
    });

    const createCall = fetchCall(fetchMock, 0);
    expect(createCall[0]).toBe("https://www.vydra.ai/api/v1/models/kling");
    const createInit = createCall[1] as { method?: string; body?: unknown } | undefined;
    expect(createInit?.method).toBe("POST");
    expect(createInit?.body).toBe(
      JSON.stringify({
        prompt: "animate this image",
        image_url: "https://example.com/reference.png",
        video_url: "https://example.com/reference.png",
      }),
    );
    expect(result.videos).toHaveLength(1);
    const [video] = result.videos;
    if (!video) {
      throw new Error("Expected generated Vydra kling video");
    }
    expect(video.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      jobId: "job-kling",
      videoUrl: "https://cdn.vydra.ai/generated/kling.mp4",
      status: "completed",
    });
  });
});
