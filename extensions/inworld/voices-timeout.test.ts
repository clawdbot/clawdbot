// Inworld voice list timeout proof.
// fetchWithSsrFGuard treats a vi.fn fetch stub as hermetic (no DNS pinning, no
// dispatcher) and passes its timeout abort signal via init.signal, so a
// never-resolving signal-honoring stub plus fake timers exercises the real
// abort path with no live sockets or wall-clock bounds to flake on loaded CI.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listInworldVoices } from "./tts.js";

describe("listInworldVoices timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a hanging voice list request within the configured timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    let rejectFetch: ((error: Error) => void) | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("guarded fetch did not pass an abort signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () =>
              reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted")),
            { once: true },
          );
          notifyFetchStarted();
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof globalThis.fetch);

    const request = listInworldVoices({
      apiKey: "test-key",
      baseUrl: "https://custom.inworld.example.com",
      timeoutMs: 250,
    });
    try {
      // Cold SDK imports must finish before the guarded fetch deadline starts.
      await Promise.race([fetchStarted, request]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(249);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      await expect(request).rejects.toThrow(/aborted|timeout|timed out/i);
    } finally {
      // Cleanup must not depend on the production timeout working.
      rejectFetch?.(new Error("test cleanup"));
      await request.catch(() => undefined);
    }
  });
});
