// Memory Core tests cover generic embedding provider.integration plugin behavior.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearEmbeddingProviders,
  listRegisteredEmbeddingProviders,
  restoreRegisteredEmbeddingProviders,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "./embeddings.js";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import type { MemorySemanticProviderGeneration } from "./manager-sync-ops.js";

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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startEmbeddingServer(options?: {
  /** Returns a rejection for a request the provider should not have sent, or undefined to serve it. */
  reject?: (inputCount: number) => { status: number; body: string } | undefined;
}): Promise<TestServer> {
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
        const rejection = options?.reject?.(texts.length);
        if (rejection) {
          res.writeHead(rejection.status, { "content-type": "application/json" });
          res.end(rejection.body);
          return;
        }
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
        Authorization: "Bearer destination-header",
        "x-api-key": "hidden",
        "x-deployment": "tenant-a",
      },
    },
    outputDimensionality: 3,
  };
}

beforeEach(() => {
  registeredEmbeddingProvidersSnapshot = listRegisteredEmbeddingProviders();
  clearEmbeddingProviders();
});

afterEach(async () => {
  const pendingServers = servers.splice(0);
  await Promise.all(pendingServers.map((server) => server.close()));
  restoreRegisteredEmbeddingProviders(registeredEmbeddingProvidersSnapshot);
});

describe("memory-core generic embedding provider contract", () => {
  it("uses the core OpenAI-compatible provider through the generic registry", async () => {
    const server = await startEmbeddingServer();

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

    await expect(result.provider?.embed("hello", { inputType: "query" })).resolves.toEqual([
      5, 0.5, 3,
    ]);
    await expect(
      result.provider?.embedBatch(["a", "abcd"], { inputType: "document" }),
    ).resolves.toEqual([
      [1, 0.5, 3],
      [4, 1.5, 3],
    ]);
    await expect(
      result.provider?.embedBatch(
        [
          {
            text: "structured doc",
            parts: [{ type: "text", text: "structured doc" }],
          },
        ],
        { inputType: "document" },
      ),
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
    expect(server.requests[0]?.headers.authorization).toBe("Bearer destination-header");
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

// Zhipu BigModel embedding-3 caps `input` at 64 items and rejects a larger array
// with HTTP 400 code 1214. Memory batches are byte-budgeted, not item-counted, so
// short chunks pack far more than 64 items into one request (issue #139040).
const ZHIPU_INPUT_ARRAY_LIMIT = 64;
const ZHIPU_REJECTION_BODY = JSON.stringify({
  error: { code: "1214", message: "input array max 64" },
});

/**
 * Drives the real Memory Core embedding owner. Only the collaborators that would
 * open an index or acquire an external provider are supplied; the batching,
 * splitting, retry classification, and timeout methods under test stay real.
 */
function createMemoryEmbeddingOwner(params: {
  provider: NonNullable<Awaited<ReturnType<typeof createEmbeddingProvider>>["provider"]>;
  providerRuntime: Awaited<ReturnType<typeof createEmbeddingProvider>>["runtime"];
  database: DatabaseSync;
}) {
  return Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    provider: params.provider,
    providerRuntime: params.providerRuntime,
    // `db` is a getter over `publishedDatabase`; the cache lookup is disabled, so
    // only the handle itself is needed to satisfy the owner's database context.
    publishedDatabase: { db: params.database },
    cache: { enabled: false },
    settings: { sync: {} },
    markLocalEmbeddingProviderDegraded: () => {},
    withProviderUse: async <T>(_provider: unknown, run: () => Promise<T>) => await run(),
  }) as {
    embedChunksInBatches: (
      chunks: IndexedMemoryChunk[],
      generation: MemorySemanticProviderGeneration,
    ) => Promise<number[][]>;
  };
}

async function createMemoryEmbeddingOwnerForServer(baseUrl: string, database: DatabaseSync) {
  const created = await createEmbeddingProvider(createMemoryEmbeddingOptions({ baseUrl }));
  const provider = created.provider;
  if (!provider) {
    throw new Error("expected the OpenAI-compatible embedding provider to be created");
  }
  const generation: MemorySemanticProviderGeneration = {
    kind: "semantic",
    provider,
    runtime: created.runtime,
    database,
    providerKey: "integration-proof",
    identities: [],
  };
  return {
    owner: createMemoryEmbeddingOwner({ provider, providerRuntime: created.runtime, database }),
    generation,
  };
}

// Unique text lengths make each vector identify its own input, because the
// fixture server answers with `[text.length, indexWithinRequest + 0.5, 3]`.
function distinctChunks(count: number): IndexedMemoryChunk[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        text: "x".repeat(index + 1),
        hash: `hash-${index}`,
        startLine: index + 1,
        endLine: index + 1,
      }) as IndexedMemoryChunk,
  );
}

describe("memory-core embedding batch recovery over real transport", () => {
  it("halves an oversized batch until the provider input array limit is met", async () => {
    const server = await startEmbeddingServer({
      reject: (inputCount) =>
        inputCount > ZHIPU_INPUT_ARRAY_LIMIT
          ? { status: 400, body: ZHIPU_REJECTION_BODY }
          : undefined,
    });
    const database = new DatabaseSync(":memory:");
    const { owner, generation } = await createMemoryEmbeddingOwnerForServer(
      server.baseUrl,
      database,
    );
    const chunks = distinctChunks(100);

    const embeddings = await owner.embedChunksInBatches(chunks, generation);

    // The byte budget alone put all 100 short chunks in one request; recovery
    // halved it until each request fit the 64-item cap.
    expect(server.requests.map((request) => (request.body.input as unknown[]).length)).toEqual([
      100, 50, 50,
    ]);
    // Vectors come back in input order across the split: the first component is
    // each chunk's own unique length, ascending.
    expect(embeddings).toEqual(
      Array.from({ length: 100 }, (_, index) => [index + 1, (index % 50) + 0.5, 3]),
    );
    database.close();
  });

  it("does not split a generic provider rejection that names no numeric bound", async () => {
    const server = await startEmbeddingServer({
      reject: () => ({
        status: 400,
        body: JSON.stringify({
          error: { code: "1214", message: "input array must contain strings" },
        }),
      }),
    });
    const database = new DatabaseSync(":memory:");
    const { owner, generation } = await createMemoryEmbeddingOwnerForServer(
      server.baseUrl,
      database,
    );

    await expect(owner.embedChunksInBatches(distinctChunks(100), generation)).rejects.toMatchObject(
      {
        code: "MEMORY_EMBEDDING_OPERATION_FAILED",
        operation: "batch",
      },
    );
    expect(server.requests).toHaveLength(1);
    database.close();
  });
});
