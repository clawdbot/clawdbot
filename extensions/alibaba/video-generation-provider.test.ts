import { beforeAll, describe, expect, it } from "vitest";
import {
  expectDashscopeVideoTaskPoll,
  expectSuccessfulDashscopeVideoResult,
  mockSuccessfulDashscopeVideoTask,
} from "../../test/helpers/media-generation/dashscope-video-provider.js";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildAlibabaVideoGenerationProvider: typeof import("./video-generation-provider.js").buildAlibabaVideoGenerationProvider;

beforeAll(async () => {
  ({ buildAlibabaVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("alibaba video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildAlibabaVideoGenerationProvider());
  });

  it("submits async Wan generation, polls task status, and downloads the resulting video", async () => {
    mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

    const provider = buildAlibabaVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "alibaba",
      model: "wan2.6-r2v-flash",
      prompt: "animate this shot",
      cfg: {},
      inputImages: [{ url: "https://example.com/ref.png" }],
      durationSeconds: 6,
      audio: true,
      watermark: false,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
        body: expect.objectContaining({
          model: "wan2.6-r2v-flash",
          input: expect.objectContaining({
            prompt: "animate this shot",
            img_url: "https://example.com/ref.png",
          }),
          parameters: expect.objectContaining({
            duration: 6,
            enable_audio: true,
            watermark: false,
          }),
        }),
      }),
    );
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock);
    expectSuccessfulDashscopeVideoResult(result);
  });

  it("fails fast when reference inputs are local buffers instead of remote URLs", async () => {
    const provider = buildAlibabaVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "alibaba",
        model: "wan2.6-i2v",
        prompt: "animate this local frame",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow(
      "Alibaba Wan video generation currently requires remote http(s) URLs for reference images/videos.",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});
