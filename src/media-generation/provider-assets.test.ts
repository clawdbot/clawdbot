import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadGeneratedVideoAsset } from "./provider-assets.js";

describe("downloadGeneratedVideoAsset", () => {
  afterEach(() => vi.useRealTimers());

  it("preserves deadline-only downloads through a pause longer than the default idle timeout", async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          setTimeout(() => controller.close(), 31_000);
        },
      }),
      { headers: { "content-type": "video/mp4" } },
    );
    const result = downloadGeneratedVideoAsset({
      url: "https://cdn.example/video",
      timeoutMs: 45_000,
      defaultTimeoutMs: 45_000,
      fetchFn: fetch,
      provider: "example",
      label: "Example generated video download",
      requestFailedMessage: "Example generated video download failed",
      validateBinaryResponse: true,
      chunkTimeoutMs: 0,
      fetchResponse: async () => ({ response }),
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(await result).toMatchObject({ buffer: Buffer.from([1, 2, 3]) });
  });

  it("preserves indexed filenames, metadata, and caller-owned response cleanup", async () => {
    const release = vi.fn(async () => undefined);
    const asset = await downloadGeneratedVideoAsset({
      url: "https://cdn.example/video",
      timeoutMs: 1_000,
      defaultTimeoutMs: 1_000,
      fetchFn: fetch,
      provider: "example",
      label: "Example generated video download",
      requestFailedMessage: "Example generated video download failed",
      index: 2,
      metadata: { sourceUrl: "https://cdn.example/video" },
      fetchResponse: async () => ({
        response: new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "video/webm" },
        }),
        release,
      }),
    });

    expect(asset).toMatchObject({
      buffer: Buffer.from([1, 2, 3]),
      mimeType: "video/webm",
      fileName: "video-3.webm",
      metadata: { sourceUrl: "https://cdn.example/video" },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels rejected binary bodies before releasing caller-owned transport", async () => {
    const cancel = vi.fn();
    const release = vi.fn(async () => undefined);

    await expect(
      downloadGeneratedVideoAsset({
        url: "https://cdn.example/video",
        timeoutMs: 1_000,
        defaultTimeoutMs: 1_000,
        fetchFn: fetch,
        provider: "example",
        label: "Example generated video download",
        requestFailedMessage: "Example generated video download failed",
        validateBinaryResponse: true,
        fetchResponse: async () => ({
          response: new Response(new ReadableStream<Uint8Array>({ cancel }), {
            headers: { "content-type": "application/json" },
          }),
          release,
        }),
      }),
    ).rejects.toThrow("Example generated video download: malformed video response");

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
