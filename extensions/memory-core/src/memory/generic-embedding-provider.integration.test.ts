import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearEmbeddingProviders,
  clearMemoryEmbeddingProviders,
  getActivePluginRegistry,
  listRegisteredEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviders,
  restoreRegisteredEmbeddingProviders,
  restoreRegisteredMemoryEmbeddingProviders,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "./embeddings.js";

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

type TestServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

const servers: TestServer[] = [];
let registeredEmbeddingProvidersSnapshot: ReturnType<typeof listRegisteredEmbeddingProviders>;
let registeredMemoryEmbeddingProvidersSnapshot: ReturnType<
  typeof listRegisteredMemoryEmbeddingProviders
>;
let restoreActiveMemoryEmbeddingProviders: (() => void) | undefined;

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startEmbeddingServer(): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readJsonBody(req);
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });
        const input = body.input;
        const texts = Array.isArray(input) ? input : [input];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: texts.map((text, index) => ({
              object: "embedding",
              embedding: [String(text).length, index + 0.5, 3],
              index,
            })),
            model: body.model,
          }),
        );
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const testServer = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(testServer);
  return testServer;
}

function createMemoryEmbeddingOptions(overrides?: {
  provider?: string;
  model?: string;
  baseUrl?: string;
}) {
  return {
    config: {
      plugins: {
        enabled: false,
      },
    } as OpenClawConfig,
    agentDir: "/tmp/openclaw-agent",
    provider: overrides?.provider ?? "openai-compatible",
    fallback: "none",
    model: overrides?.model ?? "text-embedding-bge-m3",
    inputType: "default",
    queryInputType: "query",
    documentInputType: "document",
    remote: {
      baseUrl: overrides?.baseUrl,
      apiKey: "fixture-token",
      headers: {
        Authorization: "Bearer ignored",
        "x-api-key": "hidden",
        "x-deployment": "tenant-a",
      },
    },
    outputDimensionality: 3,
  };
}

beforeEach(() => {
  registeredEmbeddingProvidersSnapshot = listRegisteredEmbeddingProviders();
  registeredMemoryEmbeddingProvidersSnapshot = listRegisteredMemoryEmbeddingProviders();
  clearEmbeddingProviders();
  clearMemoryEmbeddingProviders();

  const activeRegistry = getActivePluginRegistry();
  if (activeRegistry) {
    const memoryEmbeddingProviders = activeRegistry.memoryEmbeddingProviders;
    activeRegistry.memoryEmbeddingProviders = [];
    restoreActiveMemoryEmbeddingProviders = () => {
      activeRegistry.memoryEmbeddingProviders = memoryEmbeddingProviders;
    };
  } else {
    restoreActiveMemoryEmbeddingProviders = undefined;
  }
});

afterEach(async () => {
  const pendingServers = servers.splice(0);
  await Promise.all(pendingServers.map((server) => server.close()));
  restoreRegisteredEmbeddingProviders(registeredEmbeddingProvidersSnapshot);
  restoreRegisteredMemoryEmbeddingProviders(registeredMemoryEmbeddingProvidersSnapshot);
  restoreActiveMemoryEmbeddingProviders?.();
});

describe("memory-core generic embedding provider bridge", () => {
  it("uses the core OpenAI-compatible provider through the generic registry and memory bridge", async () => {
    const server = await startEmbeddingServer();

    expect(listRegisteredMemoryEmbeddingProviders()).toEqual([]);
    expect(listRegisteredEmbeddingProviders()).toMatchObject([
      {
        ownerPluginId: "core",
        adapter: { id: "openai-compatible" },
      },
    ]);

    const result = await createEmbeddingProvider(
      createMemoryEmbeddingOptions({ baseUrl: `  ${server.baseUrl}/  ` }),
    );

    expect(result.provider?.id).toBe("openai-compatible");
    expect(result.provider?.model).toBe("text-embedding-bge-m3");
    expect(result.runtime).toMatchObject({
      id: "openai-compatible",
      inlineBatchTimeoutMs: 600_000,
      cacheKeyData: {
        provider: "openai-compatible",
        baseUrl: server.baseUrl,
        model: "text-embedding-bge-m3",
        dimensions: 3,
        inputType: "default",
        queryInputType: "query",
        documentInputType: "document",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-deployment": "tenant-a",
        },
      },
    });
    expect(server.requests).toHaveLength(0);

    await expect(result.provider?.embedQuery("hello")).resolves.toEqual([5, 0.5, 3]);
    await expect(result.provider?.embedBatch(["a", "abcd"])).resolves.toEqual([
      [1, 0.5, 3],
      [4, 1.5, 3],
    ]);
    await expect(
      result.provider?.embedBatchInputs?.([
        {
          text: "structured doc",
          parts: [{ type: "text", text: "structured doc" }],
        },
      ]),
    ).resolves.toEqual([[14, 0.5, 3]]);

    expect(server.requests).toHaveLength(3);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/embeddings",
      body: {
        model: "text-embedding-bge-m3",
        input: ["hello"],
        dimensions: 3,
        input_type: "query",
      },
    });
    expect(server.requests[0]?.body).not.toHaveProperty("encoding_format");
    expect(server.requests[0]?.headers.authorization).toBe("Bearer fixture-token");
    expect(server.requests[0]?.headers["x-api-key"]).toBe("hidden");
    expect(server.requests[0]?.headers["x-deployment"]).toBe("tenant-a");
    expect(server.requests[1]?.body).toEqual({
      model: "text-embedding-bge-m3",
      input: ["a", "abcd"],
      dimensions: 3,
      input_type: "document",
    });
    expect(server.requests[2]?.body).toEqual({
      model: "text-embedding-bge-m3",
      input: ["structured doc"],
      dimensions: 3,
      input_type: "document",
    });
  });

  it("does not make generic embedding providers memory auto-selection candidates", async () => {
    const server = await startEmbeddingServer();

    await expect(
      createEmbeddingProvider(
        createMemoryEmbeddingOptions({
          provider: "auto",
          baseUrl: server.baseUrl,
        }),
      ),
    ).rejects.toThrow("Unknown memory embedding provider: openai");
    expect(server.requests).toHaveLength(0);
  });
});
