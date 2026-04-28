import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildBytePlusVideoGenerationProvider: typeof import("./video-generation-provider.js").buildBytePlusVideoGenerationProvider;

beforeAll(async () => {
  ({ buildBytePlusVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function mockSuccessfulBytePlusTask(params?: { model?: string }) {
  postJsonRequestMock.mockResolvedValue({
    response: {
      json: async () => ({
        id: "task_123",
      }),
    },
    release: vi.fn(async () => {}),
  });
  fetchWithTimeoutMock
    .mockResolvedValueOnce({
      json: async () => ({
        id: "task_123",
        status: "succeeded",
        content: {
          video_url: "https://example.com/byteplus.mp4",
        },
        model: params?.model ?? "seedance-1-0-lite-t2v-250428",
      }),
    })
    .mockResolvedValueOnce({
      headers: new Headers({ "content-type": "video/mp4" }),
      arrayBuffer: async () => Buffer.from("mp4-bytes"),
    });
}

describe("byteplus video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildBytePlusVideoGenerationProvider());
  });

  it("creates a content-generation task, polls, and downloads the video", async () => {
    mockSuccessfulBytePlusTask();

    const provider = buildBytePlusVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-lite-t2v-250428",
      prompt: "A lantern floats upward into the night sky",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        taskId: "task_123",
      }),
    );
  });

  it("switches t2v image requests to i2v models and lowercases resolution", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-lite-i2v-250428" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-lite-t2v-250428",
      prompt: "Animate this still image",
      resolution: "720P",
      inputImages: [{ url: "https://example.com/first-frame.png" }],
      cfg: {},
    });

    const request = postJsonRequestMock.mock.calls[0]?.[0] as { body?: Record<string, unknown> };
    expect(request.body).toMatchObject({
      model: "seedance-1-0-lite-i2v-250428",
      resolution: "720p",
      content: [
        { type: "text", text: "Animate this still image" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/first-frame.png" },
          role: "first_frame",
        },
      ],
    });
  });

  it("maps declared providerOptions into the request body", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-pro-250528" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A cinematic lobster montage",
      providerOptions: {
        seed: 42,
        draft: true,
        camera_fixed: false,
      },
      cfg: {},
    });

    const request = postJsonRequestMock.mock.calls[0]?.[0] as { body?: Record<string, unknown> };
    expect(request.body).toMatchObject({
      model: "seedance-1-0-pro-250528",
      seed: 42,
      resolution: "480p",
      camera_fixed: false,
    });
  });
});
