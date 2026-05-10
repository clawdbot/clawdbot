import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildRunwayVideoGenerationProvider: typeof import("./video-generation-provider.js").buildRunwayVideoGenerationProvider;

beforeAll(async () => {
  ({ buildRunwayVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("runway video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildRunwayVideoGenerationProvider());
  });

  it("submits a text-to-video task, polls it, and downloads the output", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "task-1",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task-1",
          status: "SUCCEEDED",
          output: ["https://example.com/out.mp4"],
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/webm" }),
      });

    const provider = buildRunwayVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "runway",
      model: "gen4.5",
      prompt: "a tiny lobster DJ under neon lights",
      cfg: {},
      durationSeconds: 4,
      aspectRatio: "16:9",
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    const createRequest = postJsonRequestMock.mock.calls[0]?.[0] as
      | { url?: string; body?: unknown }
      | undefined;
    expect(createRequest?.url).toBe("https://api.dev.runwayml.com/v1/text_to_video");
    expect(createRequest?.body).toEqual({
      model: "gen4.5",
      promptText: "a tiny lobster DJ under neon lights",
      ratio: "1280:720",
      duration: 4,
    });
    const pollCall = fetchWithTimeoutMock.mock.calls[0];
    expect(pollCall?.[0]).toBe("https://api.dev.runwayml.com/v1/tasks/task-1");
    const pollInit = pollCall?.[1] as { method?: string; headers?: unknown } | undefined;
    expect(pollInit?.method).toBe("GET");
    expect(pollInit?.headers).toBeInstanceOf(Headers);
    expect(pollCall?.[2]).toBe(120000);
    expect(pollCall?.[3]).toBe(fetch);
    expect(result.videos).toHaveLength(1);
    const video = result.videos[0];
    if (!video) {
      throw new Error("expected Runway generated video");
    }
    expect(video.fileName).toBe("video-1.webm");
    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata.taskId).toBe("task-1");
    expect(metadata.status).toBe("SUCCEEDED");
    expect(metadata.endpoint).toBe("/v1/text_to_video");
  });

  it("accepts local image buffers by converting them into data URIs", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ id: "task-2" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task-2",
          status: "SUCCEEDED",
          output: ["https://example.com/out.mp4"],
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildRunwayVideoGenerationProvider();
    await provider.generateVideo({
      provider: "runway",
      model: "gen4_turbo",
      prompt: "animate this frame",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      aspectRatio: "1:1",
      durationSeconds: 6,
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    const request = postJsonRequestMock.mock.calls[0]?.[0] as
      | { url?: string; body?: Record<string, unknown> }
      | undefined;
    expect(request?.url).toBe("https://api.dev.runwayml.com/v1/image_to_video");
    expect(request?.body?.promptImage).toMatch(/^data:image\/png;base64,/u);
    expect(request?.body?.ratio).toBe("960:960");
    expect(request?.body?.duration).toBe(6);
  });

  it("requires gen4_aleph for video-to-video", async () => {
    const provider = buildRunwayVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "restyle this clip",
        cfg: {},
        inputVideos: [{ url: "https://example.com/input.mp4" }],
      }),
    ).rejects.toThrow("Runway video-to-video currently requires model gen4_aleph.");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});
