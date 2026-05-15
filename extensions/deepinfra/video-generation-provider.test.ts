import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, resolveProviderHttpRequestConfigMock } = getProviderHttpMocks();

let buildDeepInfraVideoGenerationProvider: typeof import("./video-generation-provider.js").buildDeepInfraVideoGenerationProvider;

beforeAll(async () => {
  ({ buildDeepInfraVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function requireFirstPostJsonRequest(): unknown {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected DeepInfra video request");
  }
  return call[0];
}

describe("deepinfra video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildDeepInfraVideoGenerationProvider());
  });

  it("creates native text-to-video requests and returns the hosted output URL", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          video_url: "/generated/video.mp4",
          request_id: "req_123",
          seed: 42,
          inference_status: { status: "succeeded" },
        }),
      },
      release,
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A bicycle weaving through a rainy neon street",
      cfg: {},
      aspectRatio: "16:9",
      durationSeconds: 8,
      providerOptions: {
        seed: 42,
        negative_prompt: "blur",
        style: "anime",
      },
    });

    expect(resolveProviderHttpRequestConfigMock.mock.calls).toEqual([
      [
        {
          baseUrl: "https://api.deepinfra.com/v1/inference",
          defaultBaseUrl: "https://api.deepinfra.com/v1/inference",
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: "Bearer provider-key",
            "Content-Type": "application/json",
          },
          provider: "deepinfra",
          capability: "video",
          transport: "http",
        },
      ],
    ]);
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const postRequest = requireFirstPostJsonRequest();
    const postRequestHeaders = Reflect.get(postRequest ?? {}, "headers");
    expect(postRequestHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((postRequestHeaders as Headers).entries())).toEqual({
      authorization: "Bearer provider-key",
      "content-type": "application/json",
    });
    expect(postRequest).toEqual({
      url: "https://api.deepinfra.com/v1/inference/Pixverse/Pixverse-T2V",
      headers: postRequestHeaders,
      body: {
        prompt: "A bicycle weaving through a rainy neon street",
        aspect_ratio: "16:9",
        duration: 8,
        seed: 42,
        negative_prompt: "blur",
        style: "anime",
      },
      timeoutMs: undefined,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });
    expect(result.videos).toEqual([
      {
        url: "https://api.deepinfra.com/generated/video.mp4",
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
    expect(result.metadata).toEqual({
      requestId: "req_123",
      seed: 42,
      status: "succeeded",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports malformed native video JSON as a provider error", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      },
      release,
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A bicycle weaving through a rainy neon street",
        cfg: {},
      }),
    ).rejects.toThrow("DeepInfra video generation failed: malformed JSON response");
    expect(release).toHaveBeenCalledOnce();
  });

  it("names base64 WebM data URL outputs from the MIME type", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          video_url: `data:video/webm;base64,${Buffer.from("webm-data").toString("base64")}`,
          request_id: "req_webm",
          inference_status: { status: "succeeded" },
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A WebM data URL",
      cfg: {},
    });

    expect(result.videos).toHaveLength(1);
    const [video] = result.videos;
    if (!video) {
      throw new Error("Expected generated DeepInfra video");
    }
    expect(video).toEqual({
      buffer: Buffer.from("webm-data"),
      mimeType: "video/webm",
      fileName: "video-1.webm",
    });
  });
});
