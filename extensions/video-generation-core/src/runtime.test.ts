import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateVideo, listRuntimeVideoGenerationProviders } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  listRuntimeVideoGenerationProviders: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/video-generation-runtime", () => ({
  generateVideo: mocks.generateVideo,
  listRuntimeVideoGenerationProviders: mocks.listRuntimeVideoGenerationProviders,
}));

describe("video-generation runtime wrapper", () => {
  beforeEach(() => {
    mocks.generateVideo.mockReset();
    mocks.listRuntimeVideoGenerationProviders.mockReset();
  });

  it("delegates video generation to the shared runtime surface", async () => {
    const result = {
      videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
      provider: "video-plugin",
      model: "vid-v1",
      attempts: [],
      ignoredOverrides: [],
    };
    mocks.generateVideo.mockResolvedValue(result);
    const params = {
      cfg: {},
      prompt: "animate a cat",
    };

    await expect(generateVideo(params as never)).resolves.toEqual(result);
    expect(mocks.generateVideo).toHaveBeenCalledWith(params);
  });

  it("delegates provider listing to the shared runtime surface", () => {
    const providers = [{ id: "video-plugin" }];
    mocks.listRuntimeVideoGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeVideoGenerationProviders({ config: {} as never })).toEqual(providers);
    expect(mocks.listRuntimeVideoGenerationProviders).toHaveBeenCalledWith({
      config: {} as never,
    });
  });
});
