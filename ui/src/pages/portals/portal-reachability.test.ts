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
      "reachable",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test:43123/app",
      expect.objectContaining({ mode: "no-cors", signal: expect.any(AbortSignal) }),
    );
  });

  it("reports unreachable when the reachability deadline aborts the request", async () => {
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

    await expect(result).resolves.toBe("unreachable");
    expect(timeoutMock).toHaveBeenCalledWith(4_000);
  });

  it("reports blocked, not unreachable, when CSP refuses the probe", async () => {
    // A refused connection says nothing about the portal: frames obey frame-src,
    // so the preview must still be attempted rather than declared unreachable.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const violation = new Event("securitypolicyviolation") as Event & {
          blockedURI?: string;
        };
        violation.blockedURI = "http://127.0.0.1:42065";
        document.dispatchEvent(violation);
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );

    await expect(probePortalReachable("http://127.0.0.1:42065/?openclaw_portal=abc")).resolves.toBe(
      "blocked",
    );
  });

  it("keeps unrelated policy violations from masking an unreachable portal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const violation = new Event("securitypolicyviolation") as Event & {
          blockedURI?: string;
        };
        violation.blockedURI = "inline";
        document.dispatchEvent(violation);
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );

    await expect(probePortalReachable("http://127.0.0.1:42065/?openclaw_portal=abc")).resolves.toBe(
      "unreachable",
    );
  });
});
