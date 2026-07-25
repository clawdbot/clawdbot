// Unmocked SSRF integration tests for OpenAI-compatible embedding provider.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    await s?.close();
  }
});

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  hostname = "127.0.0.1",
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, hostname, resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://${hostname === "127.0.0.1" ? "localhost" : hostname}:${address.port}`;

  const close = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  servers.push({ close });
  return { baseUrl, port: address.port };
}

describe("openai-compatible embedding provider - unmocked SSRF private network integration", () => {
  it("fails with SsrFBlockedError on private network redirect when allowPrivateNetwork is omitted", async () => {
    // Target server binds on 127.0.0.1
    const targetServer = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
        }),
      );
    });

    // Redirect server has baseUrl http://localhost:port, redirects to http://127.0.0.1:targetPort
    const redirectServer = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetServer.port}/embeddings` });
      res.end();
    });

    const result = await openAICompatibleEmbeddingProviderAdapter.create({
      config: {
        models: {
          providers: {
            "openai-compatible": {
              baseUrl: redirectServer.baseUrl,
              models: [],
            },
          },
        },
      } as EmbeddingProviderCreateOptions["config"],
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
    });

    if (!result.provider) {
      throw new Error("expected provider");
    }

    await expect(result.provider.embed("test")).rejects.toThrow(/Blocked|SSRF|private/i);
  });

  it("succeeds through real SSRF guard when request.allowPrivateNetwork is enabled", async () => {
    const targetServer = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
        }),
      );
    });

    const redirectServer = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetServer.port}/embeddings` });
      res.end();
    });

    const result = await openAICompatibleEmbeddingProviderAdapter.create({
      config: {
        models: {
          providers: {
            "openai-compatible": {
              baseUrl: redirectServer.baseUrl,
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      } as EmbeddingProviderCreateOptions["config"],
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
    });

    if (!result.provider) {
      throw new Error("expected provider");
    }

    const embeddings = await result.provider.embed("test");
    expect(embeddings).toEqual([0.1, 0.2, 0.3]);
  });
});
