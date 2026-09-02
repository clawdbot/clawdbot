import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("LM Studio embedding request headers", () => {
  it.each([
    {
      name: "preserves resolved remote literals while resolving provider-owned headers",
      providerQuery: "",
      remoteQuery: "",
      providerOwnsDestination: true,
    },
    {
      name: "preserves query-distinct destinations without inheriting provider credentials",
      providerQuery: "?tenant=provider",
      remoteQuery: "?tenant=remote",
      providerOwnsDestination: false,
    },
  ])("$name", async ({ providerQuery, remoteQuery, providerOwnsDestination }) => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    vi.stubEnv("OPENCLAW_TEST_LMSTUDIO_LITERAL", "ambient-bait");
    vi.stubEnv("OPENCLAW_TEST_LMSTUDIO_PROVIDER", "resolved-provider-value");

    const observedRequests: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
    const server = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        observedRequests.push({ url: request.url, headers: request.headers });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.25, 0.5, 0.75] }] }));
      });
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

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
                baseUrl: `${baseUrl}${providerQuery}`,
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
          baseUrl: `${baseUrl}${remoteQuery}`,
          apiKey: "synthetic-memory-key",
          headers: {
            "X-Already-Resolved": "  ${OPENCLAW_TEST_LMSTUDIO_LITERAL}  ",
            "X-Shared": "  remote-value  ",
            "X-Empty": "   ",
          },
        },
      });

      await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([
        0.25, 0.5, 0.75,
      ]);
      expect(observedRequests).toMatchObject([
        {
          url: `/v1/embeddings${remoteQuery}`,
          headers: {
            "x-already-resolved": "${OPENCLAW_TEST_LMSTUDIO_LITERAL}",
            "x-shared": "remote-value",
            ...(providerOwnsDestination ? { "x-provider-only": "resolved-provider-value" } : {}),
            authorization: "Bearer synthetic-memory-key",
          },
        },
      ]);
      expect(observedRequests[0]?.headers).not.toHaveProperty("x-empty");
      if (!providerOwnsDestination) {
        expect(observedRequests[0]?.headers).not.toHaveProperty("x-provider-only");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
