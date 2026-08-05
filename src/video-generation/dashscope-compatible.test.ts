// DashScope-compatible download regressions: body lifecycle and operation deadlines.
import { describe, expect, it, vi } from "vitest";
import {
  downloadDashscopeGeneratedVideos,
  runDashscopeVideoGenerationTask,
} from "./dashscope-compatible.js";
import type { VideoGenerationRequest } from "./types.js";

function neverChunkingVideoResponse(): Response {
  return new Response(
    new ReadableStream({
      start() {
        // Headers only — never enqueue so the operation deadline must win.
      },
    }),
    {
      status: 200,
      headers: { "content-type": "video/mp4" },
    },
  );
}

function createVideoGenerationRequest(): VideoGenerationRequest {
  return {
    provider: "qwen",
    model: "wan2.6-t2v",
    prompt: "animate a cat",
    cfg: {},
  };
}

function waitForResponseDelay(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function createTricklingResponse(
  params: {
    status?: number;
    contentType?: string;
    intervalMs?: number;
  } = {},
) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let nextChunk: ReturnType<typeof setTimeout> | undefined;
  const cancel = vi.fn((_reason?: unknown): void => {
    if (nextChunk !== undefined) {
      clearTimeout(nextChunk);
    }
  });
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        const enqueue = () => {
          streamController.enqueue(new Uint8Array([32]));
          nextChunk = setTimeout(enqueue, params.intervalMs ?? 5);
        };
        enqueue();
      },
      cancel,
    }),
    {
      status: params.status ?? 200,
      headers: { "content-type": params.contentType ?? "application/json" },
    },
  );

  return {
    response,
    cancel,
    close() {
      if (nextChunk !== undefined) {
        clearTimeout(nextChunk);
      }
      if (controller && cancel.mock.calls.length === 0) {
        controller.close();
      }
    },
  };
}

describe("downloadDashscopeGeneratedVideos", () => {
  it("aborts a stalled generated video body at its operation deadline", async () => {
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
    ).rejects.toThrow("Alibaba Wan generated video download timed out after 80ms");

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 20);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("persists a complete generated video body before the operation deadline", async () => {
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

  it("keeps the original operation deadline while generated video bytes keep arriving", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let nextChunk: ReturnType<typeof setTimeout> | undefined;
    const cancelBody = vi.fn((_reason?: unknown): void => {
      if (nextChunk !== undefined) {
        clearTimeout(nextChunk);
      }
    });

    try {
      const deadlineAt = Date.now() + 100;
      const timeoutMs = vi.fn(() => deadlineAt - Date.now());
      const fetchFn = vi.fn(async () => {
        await waitForResponseDelay(30);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
              const enqueue = () => {
                streamController.enqueue(new Uint8Array([1]));
                nextChunk = setTimeout(enqueue, 20);
              };
              enqueue();
            },
            cancel: cancelBody,
          }),
          {
            status: 200,
            headers: { "content-type": "video/mp4" },
          },
        );
      });
      let settledError: unknown;
      const download = downloadDashscopeGeneratedVideos({
        providerLabel: "Qwen",
        urls: ["https://example.com/out.mp4"],
        timeoutMs,
        fetchFn: fetchFn as unknown as typeof fetch,
        maxBytes: 10 * 1024 * 1024,
      });
      const observedDownload = download.catch((error: unknown) => {
        settledError = error;
      });

      await vi.advanceTimersByTimeAsync(30);
      expect(timeoutMs).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(69);
      expect(settledError).toBeUndefined();
      expect(cancelBody).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(settledError).toBeInstanceOf(Error);
      expect((settledError as Error).message).toBe(
        "Qwen generated video download timed out after 70ms",
      );
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(cancelBody.mock.calls[0]?.[0]).toBe(settledError);
      await observedDownload;
    } finally {
      if (nextChunk !== undefined) {
        clearTimeout(nextChunk);
      }
      if (controller && cancelBody.mock.calls.length === 0) {
        controller.close();
      }
      vi.useRealTimers();
    }
  });

  it("keeps one numeric operation deadline across multiple video URLs and their headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let trickling: ReturnType<typeof createTricklingResponse> | undefined;

    try {
      const fetchFn = vi.fn(async () => {
        await waitForResponseDelay(30);
        if (fetchFn.mock.calls.length === 1) {
          return new Response("first-video", {
            headers: { "content-type": "video/mp4" },
          });
        }
        trickling = createTricklingResponse({ contentType: "video/mp4" });
        return trickling.response;
      });
      let settledError: unknown;
      const observedDownload = downloadDashscopeGeneratedVideos({
        providerLabel: "Qwen",
        urls: ["https://example.com/first.mp4", "https://example.com/second.mp4"],
        timeoutMs: 100,
        fetchFn: fetchFn as unknown as typeof fetch,
        maxBytes: 10 * 1024 * 1024,
      }).catch((error: unknown) => {
        settledError = error;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(settledError).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      expect(settledError).toBeInstanceOf(Error);
      expect((settledError as Error).message).toBe(
        "Qwen generated video download timed out after 100ms",
      );
      expect(trickling?.cancel).toHaveBeenCalledOnce();
      expect(trickling?.cancel.mock.calls[0]?.[0]).toBe(settledError);
      await observedDownload;
    } finally {
      trickling?.close();
      vi.useRealTimers();
    }
  });

  it("does not retry past the deadline when generated-video response headers stall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    try {
      const fetchFn = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const reason = init.signal?.reason;
                reject(reason instanceof Error ? reason : new Error("request timed out"));
              },
              { once: true },
            );
          }),
      );
      let settledError: unknown;
      const observedDownload = downloadDashscopeGeneratedVideos({
        providerLabel: "Qwen",
        urls: ["https://example.com/stalled.mp4"],
        timeoutMs: 100,
        fetchFn: fetchFn as typeof fetch,
        maxBytes: 10 * 1024 * 1024,
      }).catch((error: unknown) => {
        settledError = error;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(settledError).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settledError).toBeInstanceOf(Error);
      expect((settledError as Error).message).toContain("timed out");
      expect(fetchFn).toHaveBeenCalledOnce();
      await observedDownload;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([429, 503])(
    "cancels retry backoff at the original deadline after a late HTTP %s",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);

      try {
        const fetchFn = vi.fn(async () => {
          await waitForResponseDelay(90);
          return new Response("provider busy", { status });
        });
        let settledError: unknown;
        const observedDownload = downloadDashscopeGeneratedVideos({
          providerLabel: "Qwen",
          urls: ["https://example.com/busy.mp4"],
          timeoutMs: 100,
          fetchFn: fetchFn as unknown as typeof fetch,
          maxBytes: 10 * 1024 * 1024,
        }).catch((error: unknown) => {
          settledError = error;
        });

        await vi.advanceTimersByTimeAsync(99);
        expect(settledError).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settledError).toBeInstanceOf(Error);
        expect((settledError as Error).message).toContain("timed out");
        expect(fetchFn).toHaveBeenCalledOnce();
        await observedDownload;
      } finally {
        vi.useRealTimers();
      }
    },
  );

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

describe("runDashscopeVideoGenerationTask", () => {
  it("charges submission, polling, and trickling video bytes against the default deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let nextChunk: ReturnType<typeof setTimeout> | undefined;
    const cancelBody = vi.fn((_reason?: unknown): void => {
      if (nextChunk !== undefined) {
        clearTimeout(nextChunk);
      }
    });

    try {
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        const delayMs = requestUrl.endsWith("/out.mp4") ? 20 : 30;
        await waitForResponseDelay(delayMs);

        if (init?.method === "POST") {
          return Response.json({ output: { task_id: "task-1" } });
        }
        if (requestUrl.includes("/api/v1/tasks/")) {
          return Response.json({
            output: {
              task_status: "SUCCEEDED",
              video_url: "https://example.com/out.mp4",
            },
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
              const enqueue = () => {
                streamController.enqueue(new Uint8Array([1]));
                nextChunk = setTimeout(enqueue, 5);
              };
              enqueue();
            },
            cancel: cancelBody,
          }),
          {
            status: 200,
            headers: { "content-type": "video/mp4" },
          },
        );
      });
      let settledError: unknown;
      const observedGeneration = runDashscopeVideoGenerationTask({
        providerLabel: "Qwen",
        model: "wan2.6-t2v",
        req: createVideoGenerationRequest(),
        url: "https://example.com/api/v1/services/aigc/video-generation/video-synthesis",
        headers: new Headers(),
        baseUrl: "https://example.com",
        defaultTimeoutMs: 100,
        fetchFn: fetchFn as typeof fetch,
      }).catch((error: unknown) => {
        settledError = error;
      });

      await vi.advanceTimersByTimeAsync(80);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(cancelBody).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(19);
      expect(settledError).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      expect(settledError).toBeInstanceOf(Error);
      expect((settledError as Error).message).toBe(
        "Qwen generated video download timed out after 20ms",
      );
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(cancelBody.mock.calls[0]?.[0]).toBe(settledError);
      await observedGeneration;
    } finally {
      if (nextChunk !== undefined) {
        clearTimeout(nextChunk);
      }
      if (controller && cancelBody.mock.calls.length === 0) {
        controller.close();
      }
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "submission JSON", stage: "submit", status: 200 },
    { label: "poll JSON", stage: "poll", status: 200 },
    { label: "download HTTP error", stage: "download", status: 400 },
  ] as const)(
    "bounds a trickling $label body by the default operation deadline",
    async (params) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      let trickling: ReturnType<typeof createTricklingResponse> | undefined;

      try {
        const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          const requestUrl =
            typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
          const stage =
            init?.method === "POST"
              ? "submit"
              : requestUrl.includes("/api/v1/tasks/")
                ? "poll"
                : "download";
          await waitForResponseDelay(20);

          if (stage === params.stage) {
            trickling = createTricklingResponse({ status: params.status });
            return trickling.response;
          }
          if (stage === "submit") {
            return Response.json({ output: { task_id: "task-1" } });
          }
          if (stage === "poll") {
            return Response.json({
              output: {
                task_status: "SUCCEEDED",
                video_url: "https://example.com/out.mp4",
              },
            });
          }
          throw new Error(`unexpected video generation stage: ${stage}`);
        });
        let settledError: unknown;
        const observedGeneration = runDashscopeVideoGenerationTask({
          providerLabel: "Qwen",
          model: "wan2.6-t2v",
          req: createVideoGenerationRequest(),
          url: "https://example.com/api/v1/services/aigc/video-generation/video-synthesis",
          headers: new Headers(),
          baseUrl: "https://example.com",
          defaultTimeoutMs: 100,
          fetchFn: fetchFn as typeof fetch,
        }).catch((error: unknown) => {
          settledError = error;
        });

        await vi.advanceTimersByTimeAsync(99);
        expect(trickling).toBeDefined();
        expect(settledError).toBeUndefined();

        await vi.advanceTimersByTimeAsync(1);
        expect(settledError).toBeInstanceOf(Error);
        expect((settledError as Error).message).toContain("timed out");
        expect(trickling?.cancel).toHaveBeenCalledOnce();
        await observedGeneration;
      } finally {
        trickling?.close();
        vi.useRealTimers();
      }
    },
  );
});
