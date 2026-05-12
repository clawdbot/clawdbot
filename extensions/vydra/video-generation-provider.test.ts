import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  binaryResponse,
  jsonResponse,
  stubFetch,
  stubVydraApiKey,
} from "./provider-test-helpers.test.js";
import { buildVydraVideoGenerationProvider } from "./video-generation-provider.js";

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

    const createCall = fetchMock.mock.calls.at(0);
    expect(createCall?.[0]).toBe("https://www.vydra.ai/api/v1/models/veo3");
    const createInit = createCall?.[1] as { method?: string; body?: unknown } | undefined;
    expect(createInit?.method).toBe("POST");
    expect(createInit?.body).toBe(JSON.stringify({ prompt: "tiny city at sunrise" }));
    const pollCall = fetchMock.mock.calls.at(1);
    expect(pollCall?.[0]).toBe("https://www.vydra.ai/api/v1/jobs/job-123");
    const pollInit = pollCall?.[1] as { method?: string } | undefined;
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

    const createCall = fetchMock.mock.calls.at(0);
    expect(createCall?.[0]).toBe("https://www.vydra.ai/api/v1/models/kling");
    const createInit = createCall?.[1] as { method?: string; body?: unknown } | undefined;
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
