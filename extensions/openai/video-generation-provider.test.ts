import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock, resolveProviderHttpRequestConfigMock } =
  getProviderHttpMocks();

let buildOpenAIVideoGenerationProvider: typeof import("./video-generation-provider.js").buildOpenAIVideoGenerationProvider;

beforeAll(async () => {
  ({ buildOpenAIVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function postJsonRequest(index = 0): Record<string, unknown> {
  const request = postJsonRequestMock.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!request) {
    throw new Error(`expected postJsonRequest call ${index}`);
  }
  return request;
}

function fetchWithTimeoutCall(index: number): [string, RequestInit | undefined, number, unknown] {
  const call = fetchWithTimeoutMock.mock.calls[index] as
    | [string, RequestInit | undefined, number, unknown]
    | undefined;
  if (!call) {
    throw new Error(`expected fetchWithTimeout call ${index}`);
  }
  return call;
}

function providerHttpConfigRequest(): Record<string, unknown> {
  const [call] = resolveProviderHttpRequestConfigMock.mock.calls;
  if (!call) {
    throw new Error("expected provider HTTP config request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected provider HTTP config request");
  }
  return request as Record<string, unknown>;
}

describe("openai video generation provider", () => {
  it("declares the openai-codex alias for default-model ordering", () => {
    const provider = buildOpenAIVideoGenerationProvider();

    expect(provider.aliases).toContain("openai-codex");
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildOpenAIVideoGenerationProvider());
  });

  it("uses JSON for text-only Sora requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_123",
          model: "sora-2",
          status: "queued",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_123",
          model: "sora-2",
          status: "completed",
          seconds: "4",
          size: "720x1280",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/webm" }),
        arrayBuffer: async () => Buffer.from("webm-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "A paper airplane gliding through golden hour light",
      cfg: {},
      durationSeconds: 4,
    });

    expect(postJsonRequest().url).toBe("https://api.openai.com/v1/videos");
    const [pollUrl, pollInit, pollTimeout, pollFetch] = fetchWithTimeoutCall(0);
    expect(pollUrl).toBe("https://api.openai.com/v1/videos/vid_123");
    expect(pollInit?.method).toBe("GET");
    expect(pollTimeout).toBe(120000);
    expect(pollFetch).toBe(fetch);
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/webm");
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.metadata?.videoId).toBe("vid_123");
    expect(result.metadata?.status).toBe("completed");
  });

  it("uses JSON input_reference.image_url for image-to-video requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_456",
          model: "sora-2",
          status: "queued",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_456",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Animate this frame",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });

    const createRequest = postJsonRequest();
    expect(createRequest.url).toBe("https://api.openai.com/v1/videos");
    expect((createRequest.body as Record<string, unknown>).input_reference).toEqual({
      image_url: "data:image/png;base64,cG5nLWJ5dGVz",
    });
    const [pollUrl, pollInit, pollTimeout, pollFetch] = fetchWithTimeoutCall(0);
    expect(pollUrl).toBe("https://api.openai.com/v1/videos/vid_456");
    expect(pollInit?.method).toBe("GET");
    expect(pollTimeout).toBe(120000);
    expect(pollFetch).toBe(fetch);
  });

  it("honors configured baseUrl for video requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_local",
          model: "sora-2",
          status: "queued",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_local",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Render via local relay",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(providerHttpConfigRequest().baseUrl).toBe("http://127.0.0.1:44080/v1");
    const createRequest = postJsonRequest();
    expect(createRequest.url).toBe("http://127.0.0.1:44080/v1/videos");
    expect(createRequest.allowPrivateNetwork).toBe(false);
  });

  it("uses multipart input_reference for video-to-video uploads", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "vid_789",
          model: "sora-2",
          status: "queued",
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_789",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Remix this clip",
      cfg: {},
      inputVideos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
    });

    expect(postJsonRequestMock).not.toHaveBeenCalled();
    const [createUrl, createInit, createTimeout, createFetch] = fetchWithTimeoutCall(0);
    expect(createUrl).toBe("https://api.openai.com/v1/videos");
    expect(createInit?.method).toBe("POST");
    expect(createInit?.body).toBeInstanceOf(FormData);
    expect(createTimeout).toBe(120000);
    expect(createFetch).toBe(fetch);
  });

  it("rejects multiple reference assets", async () => {
    const provider = buildOpenAIVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "Animate these",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("a"), mimeType: "image/png" }],
        inputVideos: [{ buffer: Buffer.from("b"), mimeType: "video/mp4" }],
      }),
    ).rejects.toThrow("OpenAI video generation supports at most one reference image or video.");
  });
});
