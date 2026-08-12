/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { probePortalReachable } from "./portal-reachability.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("probePortalReachable", () => {
  it("accepts any settled no-cors response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ type: "opaque" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(probePortalReachable("https://gateway.example.test:43123/app")).resolves.toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test:43123/app",
      expect.objectContaining({ mode: "no-cors", signal: expect.any(AbortSignal) }),
    );
  });

  it("returns false when the reachability deadline aborts the request", async () => {
    const controller = new AbortController();
    const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () =>
              reject(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new Error("Request aborted"),
              ),
            { once: true },
          );
        });
      }),
    );

    const result = probePortalReachable("https://gateway.example.test:43123/app");
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(result).resolves.toBe(false);
    expect(timeoutMock).toHaveBeenCalledWith(4_000);
  });
});
