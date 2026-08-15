// DashScope-compatible lifecycle, task status, and generated-video regressions.
import { describe, expect, it, vi } from "vitest";
import {
  DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
  buildDashscopeVideoGenerationInput,
  buildDashscopeVideoGenerationParameters,
  downloadDashscopeGeneratedVideos,
  pollDashscopeVideoTaskUntilComplete,
  runDashscopeVideoGenerationTask,
} from "./dashscope-compatible.js";

const providerLabels = ["Qwen", "Alibaba Wan"] as const;

const invalidGeneratedVideos = [
  { name: "JSON error", contentType: "application/json", body: '{"error":"not a video"}' },
  {
    name: "problem JSON error",
    contentType: "application/problem+json",
    body: '{"title":"not a video"}',
  },
  { name: "HTML error", contentType: "text/html; charset=utf-8", body: "<html>error</html>" },
  { name: "image", contentType: "image/png", body: "image-bytes" },
  { name: "audio", contentType: "audio/mp4", body: "audio-bytes" },
] as const;

function neverChunkingVideoResponse(): Response {
  return new Response(
    new ReadableStream({
      start() {
        // Headers only — never enqueue so chunk idle must win.
      },
    }),
    {
      status: 200,
      headers: { "content-type": "video/mp4" },
    },
  );
}

describe("DashScope Wan request contracts", () => {
  it("advertises only the modes supported by each bundled Wan model", () => {
    expect(DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.6-t2v"]?.modes).toEqual(["generate"]);
    expect(
      DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.6-t2v"]?.capabilities?.generate
        ?.supportsAspectRatio,
    ).toBe(true);
    expect(DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.6-i2v"]?.modes).toEqual(["imageToVideo"]);
    expect(DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.6-r2v"]?.modes).toEqual([
      "imageToVideo",
      "videoToVideo",
    ]);
    expect(
      DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.7-r2v"]?.capabilities?.videoToVideo?.supportsAudio,
    ).toBe(false);
    expect(
      DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.7-r2v"]?.capabilities?.videoToVideo
        ?.supportsAspectRatio,
    ).toBe(true);
  });

  it("builds mode-specific image and reference inputs", () => {
    expect(
      buildDashscopeVideoGenerationInput({
        providerLabel: "Qwen",
        req: {
          provider: "qwen",
          model: "wan2.6-i2v",
          prompt: "animate",
          cfg: {},
          inputImages: [{ url: "https://example.com/frame.png" }],
        },
      }),
    ).toEqual({ prompt: "animate", img_url: "https://example.com/frame.png" });

    expect(
      buildDashscopeVideoGenerationInput({
        providerLabel: "Qwen",
        req: {
          provider: "qwen",
          model: "wan2.6-r2v",
          prompt: "character1 waves",
          cfg: {},
          inputImages: [{ url: "https://example.com/character.png" }],
        },
      }),
    ).toEqual({
      prompt: "character1 waves",
      reference_urls: ["https://example.com/character.png"],
    });

    expect(
      buildDashscopeVideoGenerationInput({
        providerLabel: "Alibaba Wan",
        req: {
          provider: "alibaba",
          model: "wan2.7-r2v",
          prompt: "Image 1 greets Video 1",
          cfg: {},
          inputImages: [{ url: "https://example.com/character.png" }],
          inputVideos: [{ url: "https://example.com/action.mp4", role: "reference_video" }],
        },
      }),
    ).toEqual({
      prompt: "Image 1 greets Video 1",
      media: [
        { type: "reference_image", url: "https://example.com/character.png" },
        { type: "reference_video", url: "https://example.com/action.mp4" },
      ],
    });
  });

  it("rejects model and reference mode mismatches before submission", () => {
    expect(() =>
      buildDashscopeVideoGenerationInput({
        providerLabel: "Qwen",
        req: {
          provider: "qwen",
          model: "wan2.6-t2v",
          prompt: "animate",
          cfg: {},
          inputImages: [{ url: "https://example.com/frame.png" }],
        },
      }),
    ).toThrow(/text-to-video.*does not accept reference media/u);
  });

  it.each([
    {
      name: "Wan 2.6 text-to-video",
      req: {
        provider: "qwen",
        model: "wan2.6-t2v",
        prompt: "video",
        cfg: {},
        resolution: "720P",
        aspectRatio: "9:16",
        audio: false,
      },
      expected: { size: "720*1280", audio: false },
    },
    {
      name: "Wan 2.6 image-to-video",
      req: {
        provider: "qwen",
        model: "wan2.6-i2v",
        prompt: "video",
        cfg: {},
        resolution: "1080P",
        inputImages: [{ url: "https://example.com/frame.png" }],
        audio: true,
      },
      expected: { resolution: "1080P", audio: true },
    },
    {
      name: "Wan 2.7 reference-to-video",
      req: {
        provider: "alibaba",
        model: "wan2.7-r2v",
        prompt: "video",
        cfg: {},
        size: "1920x1080",
        inputVideos: [{ url: "https://example.com/reference.mp4" }],
        audio: false,
      },
      expected: { resolution: "1080P", ratio: "16:9" },
    },
  ])("builds documented $name parameters", ({ req, expected }) => {
    expect(buildDashscopeVideoGenerationParameters(req)).toEqual(expected);
  });
});

describe("downloadDashscopeGeneratedVideos", () => {
  it.each(
    providerLabels.flatMap((providerLabel) =>
      invalidGeneratedVideos.map(({ name, contentType, body }) => ({
        providerLabel,
        name,
        contentType,
        body,
      })),
    ),
  )("rejects $providerLabel $name responses instead of returning a video", async (invalid) => {
    const fetchFn = vi.fn(
      async () =>
        new Response(invalid.body, {
          status: 200,
          headers: { "content-type": invalid.contentType },
        }),
    );

    await expect(
      downloadDashscopeGeneratedVideos({
        providerLabel: invalid.providerLabel,
        urls: ["https://example.com/not-video.mp4"],
        timeoutMs: 5_000,
        fetchFn: fetchFn as typeof fetch,
        maxBytes: 10 * 1024 * 1024,
      }),
    ).rejects.toThrow(
      `${invalid.providerLabel} generated video download: malformed video response`,
    );

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each(providerLabels)(
    "cancels unread invalid %s video bodies before releasing them",
    async (providerLabel) => {
      const cancellationOrder: string[] = [];
      const cancelBody = vi.fn(async () => {
        cancellationOrder.push("cancel-started");
        await Promise.resolve();
        cancellationOrder.push("cancel-completed");
      });
      const fetchFn = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"error":"still streaming"}'));
              },
              cancel: cancelBody,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );

      await expect(
        downloadDashscopeGeneratedVideos({
          providerLabel,
          urls: ["https://example.com/still-streaming.mp4"],
          timeoutMs: 80,
          fetchFn: fetchFn as typeof fetch,
          maxBytes: 10 * 1024 * 1024,
        }),
      ).rejects.toThrow(`${providerLabel} generated video download: malformed video response`);

      expect(cancelBody).toHaveBeenCalledOnce();
      expect(cancellationOrder).toEqual(["cancel-started", "cancel-completed"]);
    },
  );

  it.each([
    { contentType: "video/mp4", expectedMimeType: "video/mp4" },
    { contentType: "VIDEO/MP4; codecs=avc1", expectedMimeType: "VIDEO/MP4; codecs=avc1" },
    { contentType: "application/octet-stream", expectedMimeType: "application/octet-stream" },
    { contentType: undefined, expectedMimeType: "video/mp4" },
  ])(
    "preserves valid generated video content type $contentType",
    async ({ contentType, expectedMimeType }) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(new TextEncoder().encode("mp4-bytes"), {
            status: 200,
            ...(contentType ? { headers: { "content-type": contentType } } : {}),
          }),
      );

      const videos = await downloadDashscopeGeneratedVideos({
        providerLabel: "Alibaba Wan",
        urls: ["https://example.com/video.mp4"],
        timeoutMs: 5_000,
        fetchFn: fetchFn as typeof fetch,
        maxBytes: 10 * 1024 * 1024,
      });

      expect(videos[0]).toMatchObject({
        buffer: Buffer.from("mp4-bytes"),
        fileName: "video-1.mp4",
        mimeType: expectedMimeType,
      });
    },
  );

  it("aborts a stalled generated video body via chunk idle timeout", async () => {
    const fetchFn = vi.fn(async () => neverChunkingVideoResponse());
    const timeoutMs = 80;
    const startedAt = Date.now();

    await expect(
      downloadDashscopeGeneratedVideos({
        providerLabel: "Alibaba Wan",
        urls: ["https://example.com/out.mp4"],
        timeoutMs,
        fetchFn: fetchFn as unknown as typeof fetch,
        maxBytes: 10 * 1024 * 1024,
      }),
    ).rejects.toThrow("Alibaba Wan generated video download stalled: no data received for 80ms");

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 20);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("persists a complete generated video body before the idle deadline", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("mp4-bytes"));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "video/mp4" },
          },
        ),
    );

    const videos = await downloadDashscopeGeneratedVideos({
      providerLabel: "Alibaba Wan",
      urls: ["https://example.com/ok.mp4"],
      timeoutMs: 5_000,
      fetchFn: fetchFn as unknown as typeof fetch,
      maxBytes: 10 * 1024 * 1024,
    });

    expect(videos).toHaveLength(1);
    const video = videos[0];
    const buffer = video?.buffer;
    expect(video).toBeDefined();
    expect(buffer).toBeInstanceOf(Buffer);
    if (!buffer) {
      throw new Error("expected downloaded video asset buffer");
    }
    expect(buffer.toString("utf8")).toBe("mp4-bytes");
    expect(video?.mimeType).toBe("video/mp4");
  });

  it("fails closed before fetch when a function-valued remaining budget is exhausted", async () => {
    const fetchFn = vi.fn(async () => neverChunkingVideoResponse());
    const startedAt = Date.now();

    await expect(
      downloadDashscopeGeneratedVideos({
        providerLabel: "Alibaba Wan",
        urls: ["https://example.com/out.mp4"],
        // Function-valued timeout returns 0: header fetch consumed the entire
        // deadline. Must fail closed before any network I/O, not reset to the
        // full default timeout.
        timeoutMs: () => 0,
        fetchFn: fetchFn as unknown as typeof fetch,
        maxBytes: 10 * 1024 * 1024,
      }),
    ).rejects.toThrow("remaining budget exhausted");

    const elapsedMs = Date.now() - startedAt;
    // Should reject quickly (0ms budget), not wait for the 60s default.
    expect(elapsedMs).toBeLessThan(2_000);
    // Exhausted deadline is checked before fetch — no network I/O is initiated.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("releases the guarded fetch when the remaining-budget resolver throws", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const cancelBody = vi.fn();
      const timeoutMs = vi
        .fn<() => number>()
        .mockReturnValueOnce(100)
        .mockImplementationOnce(() => {
          throw new Error("remaining-budget resolver failed");
        });
      const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(new ReadableStream({ cancel: cancelBody }), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      });

      await expect(
        downloadDashscopeGeneratedVideos({
          providerLabel: "Alibaba Wan",
          urls: ["https://example.com/out.mp4"],
          timeoutMs,
          fetchFn: fetchFn as typeof fetch,
          maxBytes: 10 * 1024 * 1024,
        }),
      ).rejects.toThrow("remaining-budget resolver failed");

      expect(timeoutMs).toHaveBeenCalledTimes(2);
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(cancelBody.mock.calls[0]?.[0]).toMatchObject({
        message: "remaining-budget resolver failed",
      });
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(requestSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pollDashscopeVideoTaskUntilComplete", () => {
  it.each(providerLabels)(
    "immediately rejects documented UNKNOWN %s tasks",
    async (providerLabel) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify({ output: { task_status: " UNKNOWN " } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );

      await expect(
        pollDashscopeVideoTaskUntilComplete({
          providerLabel,
          taskId: "expired-task",
          headers: new Headers(),
          timeoutMs: 80,
          fetchFn: fetchFn as typeof fetch,
          baseUrl: "https://example.com",
        }),
      ).rejects.toThrow(
        `${providerLabel} video generation task expired-task is unknown or expired`,
      );

      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );

  it.each(providerLabels)(
    "includes the provider reason when an UNKNOWN %s task expires",
    async (providerLabel) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ output: { task_status: "UNKNOWN", message: "task was deleted" } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );

      await expect(
        pollDashscopeVideoTaskUntilComplete({
          providerLabel,
          taskId: "deleted-task",
          headers: new Headers(),
          timeoutMs: 80,
          fetchFn: fetchFn as typeof fetch,
          baseUrl: "https://example.com",
        }),
      ).rejects.toThrow(
        `${providerLabel} video generation task deleted-task is unknown or expired: task was deleted`,
      );

      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );
});

describe("runDashscopeVideoGenerationTask", () => {
  it("releases the submission request timeout before polling the task", async () => {
    vi.useFakeTimers();
    try {
      let submissionTimerCount: number | undefined;
      let pollTimerCount: number | undefined;
      const fetchFn = vi.fn(async (url: string | URL | Request) => {
        const requestUrl = url instanceof Request ? url.url : String(url);
        if (requestUrl.includes("/video-synthesis")) {
          submissionTimerCount = vi.getTimerCount();
          return new Response(JSON.stringify({ output: { task_id: "task-123" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (requestUrl.includes("/tasks/task-123")) {
          pollTimerCount = vi.getTimerCount();
          return new Response(
            JSON.stringify({
              output: { task_status: "SUCCEEDED", video_url: "https://example.com/result.mp4" },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(new TextEncoder().encode("mp4-bytes"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      });

      await runDashscopeVideoGenerationTask({
        providerLabel: "Qwen",
        model: "wan2.6-t2v",
        req: { provider: "qwen", model: "wan2.6-t2v", prompt: "video", cfg: {} },
        url: "https://example.com/video-synthesis",
        headers: new Headers(),
        baseUrl: "https://example.com",
        timeoutMs: 5_000,
        fetchFn: fetchFn as typeof fetch,
      });

      expect(submissionTimerCount).toBeGreaterThan(0);
      expect(pollTimerCount).toBe(submissionTimerCount);
    } finally {
      vi.useRealTimers();
    }
  });
});
