import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("LM Studio embedding request headers", () => {
  it("preserves resolved remote literals while resolving provider-owned headers", async () => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    vi.stubEnv("OPENCLAW_TEST_LMSTUDIO_LITERAL", "ambient-bait");
    vi.stubEnv("OPENCLAW_TEST_LMSTUDIO_PROVIDER", "resolved-provider-value");

    const observedRequests: Array<{
      path: string | undefined;
      literalHeader: string | string[] | undefined;
      sharedHeader: string | string[] | undefined;
      providerHeader: string | string[] | undefined;
      emptyHeader: string | string[] | undefined;
      authorization: string | undefined;
    }> = [];
    const server = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        observedRequests.push({
          path: request.url,
          literalHeader: request.headers["x-already-resolved"],
          sharedHeader: request.headers["x-shared"],
          providerHeader: request.headers["x-provider-only"],
          emptyHeader: request.headers["x-empty"],
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.25, 0.5, 0.75] }] }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("LM Studio embedding fixture did not expose a TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const { provider } = await createLmstudioEmbeddingProvider({
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl,
                params: { preload: false },
                headers: {
                  "X-Provider-Only": "${OPENCLAW_TEST_LMSTUDIO_PROVIDER}",
                  "X-Shared": "provider-value",
                },
                models: [],
              },
            },
          },
        },
        provider: "lmstudio",
        model: "fixture-embedding-model",
        fallback: "none",
        remote: {
          baseUrl,
          apiKey: "synthetic-memory-key",
          headers: {
            "X-Already-Resolved": "  ${OPENCLAW_TEST_LMSTUDIO_LITERAL}  ",
            "X-Shared": "  remote-value  ",
            "X-Empty": "   ",
          },
        },
      });

      await expect(provider.embedQuery("hello")).resolves.toEqual([0.25, 0.5, 0.75]);
      expect(observedRequests).toEqual([
        {
          path: "/v1/embeddings",
          literalHeader: "${OPENCLAW_TEST_LMSTUDIO_LITERAL}",
          sharedHeader: "remote-value",
          providerHeader: "resolved-provider-value",
          emptyHeader: undefined,
          authorization: "Bearer synthetic-memory-key",
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
