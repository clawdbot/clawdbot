// Azure Speech voice list timeout integration proof.
// A loopback server accepts the connection but never responds so this exercises
// the real fetch abort path without depending on Azure latency.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAzureSpeechVoices } from "./tts.js";

async function listenLocal(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

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
    const server = createServer((_request, _response) => {
      requestCount += 1;
      notifyRequest();
    });

    const port = await listenLocal(server);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        if (!requestSignal) {
          throw new Error("guarded fetch did not pass an abort signal");
        }
        return await originalFetch(`http://127.0.0.1:${port}/cognitiveservices/voices/list`, {
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
      await closeServer(server);
    }
  });
});
