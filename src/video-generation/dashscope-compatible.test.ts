// DashScope-compatible download regressions: body idle after headers.
import { describe, expect, it, vi } from "vitest";
import { downloadDashscopeGeneratedVideos } from "./dashscope-compatible.js";

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

describe("downloadDashscopeGeneratedVideos", () => {
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
