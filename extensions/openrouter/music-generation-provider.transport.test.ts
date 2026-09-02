// OpenRouter transport tests cover real provider-http request policy enforcement.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyForProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    apiKey: "test",
    source: "profile",
    mode: "api-key",
  })),
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

async function buildTransportProofProvider() {
  vi.resetModules();
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.doMock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
    resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  }));
  const { buildOpenRouterMusicGenerationProvider } = await import("./music-generation-provider.js");
  return buildOpenRouterMusicGenerationProvider();
}

const openServers: Server[] = [];

async function startPrivateMusicServer(): Promise<{
  baseUrl: string;
  requestCount: () => number;
}> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(204);
    response.end();
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    requestCount: () => requests,
  };
}

async function closeOpenServers() {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
}

describe("openrouter music generation provider transport", () => {
  afterEach(async () => {
    await closeOpenServers();
  });

  it("denies private destinations even when the configured request policy opts in", async () => {
    const server = await startPrivateMusicServer();

    const provider = await buildTransportProofProvider();
    await expect(
      provider.generateMusic({
        provider: "openrouter",
        model: "google/lyria-3-pro-preview",
        prompt: "transport denial proof",
        cfg: {
          models: {
            providers: {
              openrouter: {
                baseUrl: server.baseUrl,
                request: {
                  allowPrivateNetwork: true,
                  headers: { "X-OpenRouter-Trace": "transport-proof" },
                },
              },
            },
          },
        } as never,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(server.requestCount()).toBe(0);
  });
});
