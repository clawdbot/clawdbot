import { once } from "node:events";
import { createServer } from "node:http";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverLlamaServer } from "./discovery.js";

const discoverRowsMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-setup")>()),
  discoverOpenAICompatibleLocalModels: discoverRowsMock,
}));

describe("llama-server discovery projection", () => {
  beforeEach(() => {
    discoverRowsMock.mockReset();
    clearLiveCatalogCacheForTests();
  });

  it("projects shared model rows and llama.cpp properties", async () => {
    discoverRowsMock.mockResolvedValue({
      kind: "success",
      health: "loading",
      fetchedAt: 123,
      rows: [
        {
          model: {
            id: "qwen/model:Q4_K_M",
            object: "model",
            status: { value: "sleeping" },
          },
          props: {
            default_generation_settings: { n_ctx: 32_768 },
            chat_template_caps: { supports_tools: true, supports_tool_calls: true },
          },
        },
      ],
    });

    await expect(
      discoverLlamaServer({ baseUrl: "http://localhost:8080/v1", cacheTtlMs: 0 }),
    ).resolves.toMatchObject({
      kind: "success",
      endpoint: {
        origin: "http://localhost:8080",
        inferenceBaseUrl: "http://localhost:8080/v1",
      },
      models: [
        {
          status: "sleeping",
          config: {
            id: "qwen/model:Q4_K_M",
            contextWindow: 32_768,
            compat: { supportsTools: true },
          },
        },
      ],
    });
    expect(discoverRowsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:8080/v1",
      serverBaseUrl: "http://localhost:8080",
      apiKey: undefined,
      headers: undefined,
      label: "llama-server",
      healthPath: "/health",
      modelsPathOrder: "server-first",
      routerModelProps: true,
      timeoutMs: 5_000,
      signal: undefined,
      rawResult: true,
    });
  });

  it("attaches the normalized endpoint to shared discovery failures", async () => {
    discoverRowsMock.mockResolvedValue({
      kind: "invalid-response",
      path: "/models",
      error: new Error("malformed"),
    });

    await expect(
      discoverLlamaServer({ baseUrl: "localhost:8080", cacheTtlMs: 0 }),
    ).resolves.toMatchObject({
      kind: "invalid-response",
      path: "/models",
      endpoint: {
        origin: "http://localhost:8080",
        inferenceBaseUrl: "http://localhost:8080/v1",
      },
    });
  });

  it.each([
    { name: "HTML app shell", body: "<!doctype html><html><body>Local model app</body></html>" },
    { name: "non-model JSON", body: JSON.stringify({ app: "local-models" }) },
  ])("discovers an existing server behind a root $name response", async ({ body }) => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-setup")>(
      "openclaw/plugin-sdk/provider-setup",
    );
    discoverRowsMock.mockImplementation(actual.discoverOpenAICompatibleLocalModels);
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/models") {
        response.end(body);
      } else if (request.url === "/v1/models") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "local-model", object: "model" }] }));
      } else {
        response.end("{}");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a listening TCP server");
      }
      await expect(
        discoverLlamaServer({ baseUrl: `http://127.0.0.1:${address.port}`, cacheTtlMs: 0 }),
      ).resolves.toMatchObject({
        kind: "success",
        models: [{ config: { id: "local-model" } }],
      });
      expect(requests).toEqual(["/health", "/models", "/v1/models", "/props"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([
    { name: "API key", access: { apiKey: "endpoint-key" } },
    { name: "authorization header", access: { headers: { Authorization: "Bearer endpoint-key" } } },
    { name: "explicit refresh", access: { cacheTtlMs: 0 } },
  ])("fetches $name discovery after an anonymous catalog was cached", async ({ access }) => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-setup")>(
      "openclaw/plugin-sdk/provider-setup",
    );
    discoverRowsMock.mockImplementation(actual.discoverOpenAICompatibleLocalModels);
    let modelId = "anonymous-model";
    const modelRequests: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/models") {
        modelRequests.push(request.headers.authorization);
        response.end(JSON.stringify({ data: [{ id: modelId, status: { value: "unloaded" } }] }));
      } else {
        response.end("{}");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a listening TCP server");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      await expect(discoverLlamaServer({ baseUrl })).resolves.toMatchObject({
        kind: "success",
        models: [{ config: { id: "anonymous-model" } }],
      });
      modelId = "fresh-model";
      await expect(discoverLlamaServer({ baseUrl, ...access })).resolves.toMatchObject({
        kind: "success",
        models: [{ config: { id: "fresh-model" } }],
      });
      await expect(discoverLlamaServer({ baseUrl })).resolves.toMatchObject({
        kind: "success",
        models: [{ config: { id: "anonymous-model" } }],
      });
      expect(modelRequests).toEqual([
        undefined,
        "cacheTtlMs" in access ? undefined : "Bearer endpoint-key",
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
