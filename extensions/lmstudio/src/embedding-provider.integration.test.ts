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

it.each(["single", "documents", "queries", "cancelled"] as const)(
  "routes %s embeddings to sufficient-context instances across eviction while holding the service lease",
  async (kind) => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    let holdLoad = false;
    let signalLoadStarted: () => void = () => {};
    const loadStarted = new Promise<void>((resolve) => {
      signalLoadStarted = resolve;
    });
    let loaded = true;
    let instanceNumber = 2;
    let leases = 0;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      let text = "";
      request.on("data", (chunk: unknown) => {
        if (!Buffer.isBuffer(chunk)) {
          throw new Error("Expected request bytes");
        }
        text += chunk.toString("utf8");
      });
      request.once("end", () => {
        requests.push(request.url ?? "");
        expect(leases).toBeGreaterThan(0);
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/v1/models") {
          response.end(
            JSON.stringify({
              models: [
                {
                  key: "embedding-model",
                  type: "embedding",
                  max_context_length: 2048,
                  loaded_instances: loaded
                    ? [
                        { id: "embedding-model", config: { context_length: 1024 } },
                        {
                          id: `embedding-model:${instanceNumber}`,
                          config: { context_length: 2048 },
                        },
                      ]
                    : [],
                },
              ],
            }),
          );
        } else if (request.url === "/api/v1/models/load") {
          if (holdLoad) {
            signalLoadStarted();
            return;
          }
          loaded = true;
          instanceNumber++;
          response.end(
            JSON.stringify({ status: "loaded", instance_id: `embedding-model:${instanceNumber}` }),
          );
        } else if (request.url === "/v1/embeddings" && loaded) {
          const body: unknown = JSON.parse(text);
          if (
            !body ||
            typeof body !== "object" ||
            !("model" in body) ||
            !("input" in body) ||
            !Array.isArray(body.input)
          ) {
            throw new Error("Invalid embedding request");
          }
          const embedding = body.model === `embedding-model:${instanceNumber}` ? [1, 0] : [0, 1];
          response.end(
            JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding })) }),
          );
        } else {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "No models loaded" }));
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing fixture address");
      }
      const { provider, client } = await createLmstudioEmbeddingProvider({
        provider: "lmstudio",
        model: "embedding-model",
        fallback: "none",
        remote: { apiKey: "lmstudio-local" },
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "lmstudio-local",
                localService: { command: "/usr/bin/lms" },
                models: [
                  {
                    id: "embedding-model",
                    name: "Embedding model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    maxTokens: 0,
                    contextTokens: 2048,
                  },
                ],
              },
            },
          },
        },
        acquireLocalService: async () => {
          leases++;
          return {
            release: () => {
              leases--;
            },
          };
        },
      });
      expect(leases).toBe(0);
      await expect(provider.embed("first")).resolves.toEqual([1, 0]);
      expect(requests).not.toContain("/api/v1/models/load");
      loaded = false;
      requests.length = 0;
      if (kind === "cancelled") {
        holdLoad = true;
        const activeController = new AbortController();
        const active = provider.embed("active", { signal: activeController.signal });
        await loadStarted;
        const queuedController = new AbortController();
        const queued = provider.embed("queued", { signal: queuedController.signal });
        await vi.waitFor(() => expect(leases).toBe(2));
        queuedController.abort(new Error("cancelled while queued"));
        await expect(queued).rejects.toThrow("cancelled while queued");
        expect(leases).toBe(1);
        expect(requests).toEqual(["/api/v1/models", "/api/v1/models/load"]);
        const recovered = provider.embed("recovered");
        holdLoad = false;
        activeController.abort(new Error("cancelled active load"));
        await expect(active).rejects.toThrow("cancelled active load");
        await expect(recovered).resolves.toEqual([1, 0]);
        expect(requests.filter((url) => url === "/v1/embeddings")).toHaveLength(1);
      } else if (kind === "single") {
        await expect(provider.embed("second")).resolves.toEqual([1, 0]);
      } else {
        await expect(
          provider.embedBatch(["second", "third"], {
            inputType: kind === "queries" ? "query" : "document",
          }),
        ).resolves.toEqual([
          [1, 0],
          [1, 0],
        ]);
      }
      expect(requests.indexOf("/api/v1/models/load")).toBeGreaterThanOrEqual(0);
      expect(requests.indexOf("/api/v1/models/load")).toBeLessThan(
        requests.indexOf("/v1/embeddings"),
      );
      expect(leases).toBe(0);
      expect(provider.model).toBe("embedding-model");
      expect(client.model).toBe("embedding-model");
      requests.length = 0;
      await expect(provider.embedBatch([])).resolves.toEqual([]);
      expect(requests).toEqual([]);
      const aborted = AbortSignal.abort(new Error("cancelled before preload"));
      await expect(provider.embed("cancelled", { signal: aborted })).rejects.toThrow(
        "cancelled before preload",
      );
      expect(requests).toEqual([]);
      expect(leases).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  },
);
