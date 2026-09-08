// Azure Speech voice list timeout integration proof.
// A loopback server accepts the connection but never responds so this exercises
// the real fetch abort path without depending on Azure latency.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAzureSpeechVoices } from "./tts.js";

describe("listAzureSpeechVoices timeout", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts a hanging voice list request within the configured timeout", async () => {
    let requestCount = 0;
    let requestSignal: AbortSignal | undefined;
    const cleanupController = new AbortController();
    let notifyRequest = () => {};
    const requestReceived = new Promise<void>((resolve) => {
      notifyRequest = resolve;
    });
    await withServer(
      (_request, _response) => {
        requestCount += 1;
        notifyRequest();
      },
      async (baseUrl) => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined;
            if (!requestSignal) {
              throw new Error("guarded fetch did not pass an abort signal");
            }
            return await originalFetch(`${baseUrl}/cognitiveservices/voices/list`, {
              ...init,
              signal: AbortSignal.any([requestSignal, cleanupController.signal]),
            });
          }) as unknown as typeof globalThis.fetch,
        );

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const request = listAzureSpeechVoices({
          apiKey: "not-a-real",
          baseUrl: "https://custom.example.com",
          timeoutMs: 100,
        });
        try {
          // Measure the request deadline after cold SDK imports and socket setup finish.
          await Promise.race([requestReceived, request]);
          expect(requestCount).toBe(1);
          await vi.advanceTimersByTimeAsync(99);
          expect(requestSignal?.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(requestSignal?.aborted).toBe(true);
          await expect(request).rejects.toThrow(/aborted|timeout|timed out/i);
        } finally {
          // Abort independently of the production deadline, then settle before global/socket cleanup.
          cleanupController.abort();
          await request.catch(() => undefined);
          vi.useRealTimers();
        }
      },
    );
  });
});
