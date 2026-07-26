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

  it(
    "aborts a hanging voice list request within the configured timeout",
    { timeout: 2_000 },
    async () => {
      let requestCount = 0;
      const server = createServer((_req, _res) => {
        requestCount += 1;
      });

      const port = await listenLocal(server);

      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          return await originalFetch(
            `http://127.0.0.1:${port}/cognitiveservices/voices/list`,
            init,
          );
        }) as unknown as typeof globalThis.fetch,
      );

      const startedAt = Date.now();
      let watchdog: ReturnType<typeof setTimeout> | undefined;

      try {
        await expect(
          Promise.race([
            listAzureSpeechVoices({
              apiKey: "not-a-real",
              baseUrl: "https://custom.example.com",
              timeoutMs: 100,
            }),
            new Promise<never>((_, reject) => {
              watchdog = setTimeout(() => reject(new Error("voices list did not time out")), 1_000);
            }),
          ]),
        ).rejects.toThrow(/aborted|timeout|timed out/i);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(requestCount).toBe(1);
      } finally {
        if (watchdog) {
          clearTimeout(watchdog);
        }
        await closeServer(server);
      }
    },
  );
});
