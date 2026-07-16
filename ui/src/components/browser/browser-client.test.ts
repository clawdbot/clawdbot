import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBrowserScreenshotDataUrl } from "./browser-client.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchBrowserScreenshotDataUrl", () => {
  it("returns the fetched screenshot as a data URL", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const screenshot = new Blob(["image-bytes"], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => ({ ok: true, blob: async () => screenshot }) as Response),
    );

    await expect(
      fetchBrowserScreenshotDataUrl({
        basePath: "/openclaw/",
        authToken: null,
        path: "/tmp/browser shot.png",
      }),
    ).resolves.toBe("data:image/png;base64,aW1hZ2UtYnl0ZXM=");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unsuccessful screenshot responses", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })),
    );

    await expect(
      fetchBrowserScreenshotDataUrl({
        basePath: "/openclaw",
        authToken: null,
        path: "/tmp/missing.png",
      }),
    ).rejects.toThrow("screenshot fetch failed (404)");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled screenshot fetch after the request deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing screenshot fetch signal");
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            // Fetch rejects with the exact abort reason. DOM types define it as an Error,
            // although jsdom does not preserve that prototype relationship at runtime.
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBrowserScreenshotDataUrl({
      basePath: "/openclaw",
      authToken: null,
      path: "/tmp/browser shot.png",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fbrowser+shot.png");
    expect(init?.signal?.aborted).toBe(false);

    const outcome = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(init?.signal?.aborted).toBe(true);
  });

  it("aborts a stalled screenshot body after the request deadline", async () => {
    vi.useFakeTimers();
    let bodyReadStarted = false;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing screenshot fetch signal");
      }
      return {
        ok: true,
        blob: async () => {
          bodyReadStarted = true;
          return await new Promise<Blob>((_resolve, reject) => {
            const rejectWithAbortReason = () => reject(signal.reason as Error);
            if (signal.aborted) {
              rejectWithAbortReason();
              return;
            }
            signal.addEventListener("abort", rejectWithAbortReason, { once: true });
          });
        },
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBrowserScreenshotDataUrl({
      basePath: "/openclaw",
      authToken: null,
      path: "/tmp/browser shot.png",
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    await Promise.resolve();
    await Promise.resolve();
    expect(bodyReadStarted).toBe(true);
    expect(init?.signal?.aborted).toBe(false);

    const outcome = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(init?.signal?.aborted).toBe(true);
  });
});
