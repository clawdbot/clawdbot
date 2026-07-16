import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, getJsonNoStore, postJson } from "./http.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("QA Lab dashboard HTTP", () => {
  it("gives every API request a fresh 30 second deadline", async () => {
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      expect(timeoutMs).toBe(30_000);
      const controller = controllers.shift();
      if (!controller) {
        throw new Error("unexpected timeout signal request");
      }
      return controller.signal;
    });
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getJson("/api/bootstrap");
    await getJsonNoStore("/api/snapshot");
    await postJson("/api/runner/start", { scenario: "baseline" });

    expect(timeout).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/bootstrap",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/snapshot",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/runner/start",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects a stalled request when its deadline aborts", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("missing request signal");
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
      }),
    );

    const request = getJson("/api/stalled");
    timeoutController.abort(new DOMException("request deadline exceeded", "TimeoutError"));

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
