import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
} from "./embeddings-remote-provider.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startEmbeddingServer() {
  const authorization: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    void (async () => {
      for await (const chunk of request) {
        // Drain the request before responding so the proof uses the real HTTP path.
        void chunk;
      }
      authorization.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.25, 0.5, 0.75] }],
        }),
      );
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
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  servers.push({ close });
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    authorization,
  };
}

describe("remote embedding provider credentials", () => {
  it("sends a resolved template-looking credential unchanged to loopback", async () => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    vi.stubEnv("OPENCLAW_TEST_LITERAL_SECRET", "ambient-bait");
    const server = await startEmbeddingServer();
    const client = await resolveRemoteEmbeddingClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      normalizeModel: (model) => model,
      options: {
        config: { models: {} } as never,
        model: "text-embedding-3-small",
        remote: {
          baseUrl: server.baseUrl,
          apiKey: "${OPENCLAW_TEST_LITERAL_SECRET}",
        },
      },
    });
    const provider = createRemoteEmbeddingProvider({
      id: "openai",
      client,
      errorPrefix: "loopback embeddings failed",
    });

    await expect(provider.embedQuery("hello")).resolves.toEqual([0.25, 0.5, 0.75]);
    expect(server.authorization).toEqual(["Bearer ${OPENCLAW_TEST_LITERAL_SECRET}"]);
  });

  it("rejects an unresolved structured ref before loopback egress", async () => {
    const server = await startEmbeddingServer();

    await expect(
      resolveRemoteEmbeddingClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        normalizeModel: (model) => model,
        options: {
          config: { models: {} } as never,
          model: "text-embedding-3-small",
          remote: {
            baseUrl: server.baseUrl,
            apiKey: {
              source: "env",
              provider: "default",
              id: "MISSING_MEMORY_KEY",
            },
          },
        },
      }),
    ).rejects.toMatchObject({ name: "UnresolvedSecretInputError" });
    expect(server.authorization).toHaveLength(0);
  });
});
