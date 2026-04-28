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

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepinfra",
        capability: "video",
        baseUrl: "https://api.deepinfra.com/v1/inference",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.deepinfra.com/v1/inference/Pixverse/Pixverse-T2V",
        body: {
          prompt: "A bicycle weaving through a rainy neon street",
          aspect_ratio: "16:9",
          duration: 8,
          seed: 42,
          negative_prompt: "blur",
          style: "anime",
        },
      }),
    );
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
});
