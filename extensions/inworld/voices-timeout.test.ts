import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listInworldVoices } from "./tts.js";

describe("listInworldVoices live timeout", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    "aborts a hanging voice list request within the configured timeout",
    { timeout: 2_000 },
    async () => {
      let requestCount = 0;
      let notifyRequest = () => {};
      const requestReceived = new Promise<void>((resolve) => {
        notifyRequest = resolve;
      });
      await withServer(
        (request) => {
          requestCount += 1;
          notifyRequest();
          request.resume();
        },
        async (baseUrl) => {
          vi.stubGlobal(
            "fetch",
            vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
              return await originalFetch(`${baseUrl}/voices/v1/voices`, init);
            }) as unknown as typeof globalThis.fetch,
          );

          let watchdog: ReturnType<typeof setRealTimeout> | undefined;
          try {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const watchdogPromise = new Promise<never>((_, reject) => {
              watchdog = setRealTimeout(
                () => reject(new Error("voices list did not time out")),
                1_000,
              );
            });
            const request = Promise.race([
              listInworldVoices({
                apiKey: "test-key",
                baseUrl: "https://custom.inworld.example.com",
                timeoutMs: 250,
              }),
              watchdogPromise,
            ]);
            const rejection = expect(request).rejects.toThrow(/aborted|timeout|timed out/i);

            await Promise.race([requestReceived, watchdogPromise]);
            expect(requestCount).toBe(1);
            await vi.advanceTimersByTimeAsync(250);
            await rejection;
          } finally {
            vi.useRealTimers();
            if (watchdog) {
              clearRealTimeout(watchdog);
            }
          }
        },
      );
    },
  );
});
