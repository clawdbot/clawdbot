// Covers the OpenAI-compatible embedding provider's per-call stall deadlines.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

const servers: Array<{ close: () => Promise<void> }> = [];

function createOptions(
  overrides: Partial<EmbeddingProviderCreateOptions> = {},
): EmbeddingProviderCreateOptions {
  return {
    config: {} as EmbeddingProviderCreateOptions["config"],
    provider: "openai-compatible",
    model: "text-embedding-bge-m3",
    ...overrides,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startNeverRespondingEmbeddingServer(): Promise<{ baseUrl: string }> {
  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage, _res: ServerResponse) => {
    void readJsonBody(req).then(() => {
      // Never respond: the request hangs until the client gives up.
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });

  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.close()));
});

async function createProvider(options: EmbeddingProviderCreateOptions) {
  const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
  if (!result.provider) {
    throw new Error("expected openai-compatible embedding provider");
  }
  return result.provider;
}

describe("openai-compatible embedding stall deadlines", () => {
  it("times out query embedding calls on a stalled provider with the configured timeoutSeconds", async () => {
    const server = await startNeverRespondingEmbeddingServer();
    const provider = await createProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "tenant-embeddings": {
                baseUrl: server.baseUrl,
                timeoutSeconds: 1,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "tenant-embeddings",
        model: "text-embedding-bge-m3",
      }),
    );

    const outcome = await withTestTimeout(
      provider.embed("hello", { inputType: "query" }).then(
        () => ({ type: "resolved" as const }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      5_000,
      "timed out waiting for the embedding stall deadline",
    );
    if (outcome.type !== "rejected") {
      throw new Error(`expected embedding request to reject, got ${outcome.type}`);
    }
    expect((outcome.error as Error).message).toBe(
      "openai-compatible embeddings request timed out after 1s",
    );
  });

  it("bounds document batches with an explicit provider timeoutSeconds", async () => {
    const server = await startNeverRespondingEmbeddingServer();
    const provider = await createProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "tenant-embeddings": {
                baseUrl: server.baseUrl,
                timeoutSeconds: 1,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "tenant-embeddings",
        model: "text-embedding-bge-m3",
      }),
    );

    await expect(
      withTestTimeout(
        provider.embedBatch(["doc"], { inputType: "document" }),
        5_000,
        "timed out waiting for the explicit provider batch deadline",
      ),
    ).rejects.toThrow("openai-compatible embeddings request timed out after 1s");
  });

  it("keeps the caller signal ahead of the client stall deadline", async () => {
    const server = await startNeverRespondingEmbeddingServer();
    const provider = await createProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "tenant-embeddings": {
                baseUrl: server.baseUrl,
                timeoutSeconds: 30,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "tenant-embeddings",
        model: "text-embedding-bge-m3",
      }),
    );
    const controller = new AbortController();
    const callerAbort = setTimeout(() => controller.abort(), 150);

    try {
      const outcome = await withTestTimeout(
        provider.embed("hello", { inputType: "query", signal: controller.signal }).then(
          () => ({ type: "resolved" as const }),
          (error: unknown) => ({ type: "rejected" as const, error }),
        ),
        5_000,
        "timed out waiting for the caller abort",
      );
      if (outcome.type !== "rejected") {
        throw new Error(`expected embedding request to reject, got ${outcome.type}`);
      }
      expect((outcome.error as Error).message).not.toContain("request timed out after");
    } finally {
      clearTimeout(callerAbort);
    }
  });
});
