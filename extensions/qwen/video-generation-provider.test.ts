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

let buildQwenVideoGenerationProvider: typeof import("./video-generation-provider.js").buildQwenVideoGenerationProvider;

beforeAll(async () => {
  ({ buildQwenVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("qwen video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildQwenVideoGenerationProvider());
  });

  it("submits async Wan generation, polls task status, and downloads the resulting video", async () => {
    mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

    const provider = buildQwenVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "qwen",
      model: "wan2.6-r2v-flash",
      prompt: "animate this shot",
      cfg: {},
      inputImages: [{ url: "https://example.com/ref.png" }],
      durationSeconds: 6,
      audio: true,
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
        }),
      }),
    );
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock);
    expectSuccessfulDashscopeVideoResult(result);
  });

  it("fails fast when reference inputs are local buffers instead of remote URLs", async () => {
    const provider = buildQwenVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "qwen",
        model: "wan2.6-i2v",
        prompt: "animate this local frame",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow(
      "Qwen video generation currently requires remote http(s) URLs for reference images/videos.",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("preserves dedicated coding endpoints for dedicated API keys", async () => {
    mockSuccessfulDashscopeVideoTask(
      {
        postJsonRequestMock,
        fetchWithTimeoutMock,
      },
      { requestId: "req-2", taskId: "task-2" },
    );

    const provider = buildQwenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "qwen",
      model: "wan2.6-t2v",
      prompt: "animate this shot",
      cfg: {
        models: {
          providers: {
            qwen: {
              baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://coding-intl.dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      }),
    );
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock, {
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com",
      taskId: "task-2",
    });
  });
});
