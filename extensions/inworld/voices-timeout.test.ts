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
      await withServer(
        (request) => {
          requestCount += 1;
          request.resume();
        },
        async (baseUrl) => {
          vi.stubGlobal(
            "fetch",
            vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
              return await originalFetch(`${baseUrl}/voices/v1/voices`, init);
            }) as unknown as typeof globalThis.fetch,
          );

          await expect(
            listInworldVoices({
              apiKey: "test-key",
              baseUrl: "https://custom.inworld.example.com",
              timeoutMs: 250,
            }),
          ).rejects.toThrow(/aborted|timeout|timed out/i);
          expect(requestCount).toBe(1);
        },
      );
    },
  );
});
