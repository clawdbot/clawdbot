import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { summarizeInStages } from "./compaction.js";
import type { AgentMessage } from "./runtime/index.js";
import type { ExtensionContext } from "./sessions/index.js";

describe("compaction retry backoff over real HTTP", () => {
  it("aborts after one provider response without changing the source history", async () => {
    const controller = new AbortController();
    const requests: Array<{ method: string; path: string }> = [];
    let responseCompletedAt: number | undefined;
    let abortedAt: number | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;

    const server = createServer((request, response) => {
      request.resume();
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
      });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Transient loopback provider rejection",
            type: "invalid_request_error",
            code: "loopback_compaction_retry",
          },
        }),
        () => {
          // Start cancellation only after the real provider response can put
          // production compaction into its minimum 500 ms retry backoff.
          if (requests.length === 1) {
            responseCompletedAt = performance.now();
            abortTimer = setTimeout(() => {
              abortedAt = performance.now();
              controller.abort();
            }, 200);
          }
        },
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Compaction loopback server did not expose a TCP port");
      }
      const model = {
        id: "loopback-compaction-model",
        name: "Loopback compaction model",
        api: "openai-completions",
        provider: "openai",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      } satisfies NonNullable<ExtensionContext["model"]>;

      const messages: AgentMessage[] = [
        {
          role: "user",
          content: "Keep this original conversation and opaque ID 5cf86ba9 unchanged.",
          timestamp: 1,
        },
      ];
      const originalHistory = Buffer.from(JSON.stringify(messages));

      const summary = summarizeInStages({
        messages,
        model,
        apiKey: "loopback-test-key", // pragma: allowlist secret
        signal: controller.signal,
        reserveTokens: 1_000,
        maxChunkTokens: 50_000,
        contextWindow: model.contextWindow,
        parts: 1,
      });

      await expect(summary).rejects.toThrow(/abort/i);
      if (responseCompletedAt === undefined || abortedAt === undefined) {
        throw new Error("Compaction did not abort after the real loopback response");
      }
      expect(performance.now() - abortedAt).toBeLessThan(400);
      expect(performance.now() - responseCompletedAt).toBeLessThan(400);
      expect(requests).toEqual([{ method: "POST", path: "/v1/chat/completions" }]);
      expect(Buffer.from(JSON.stringify(messages)).equals(originalHistory)).toBe(true);
    } finally {
      if (abortTimer !== undefined) {
        clearTimeout(abortTimer);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
