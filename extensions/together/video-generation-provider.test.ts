import { beforeAll, describe, expect, it, vi } from "vitest";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildTogetherVideoGenerationProvider: typeof import("./video-generation-provider.js").buildTogetherVideoGenerationProvider;

beforeAll(async () => {
  ({ buildTogetherVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("together video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildTogetherVideoGenerationProvider());
  });

  it("creates a video, polls completion, and downloads the output", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video_123",
          status: "in_progress",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "video_123",
          status: "completed",
          outputs: { video_url: "https://example.com/together.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildTogetherVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "together",
      model: "Wan-AI/Wan2.2-T2V-A14B",
      prompt: "A bicycle weaving through a rainy neon street",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.together.xyz/v1/videos",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        videoId: "video_123",
      }),
    );
  });
});
