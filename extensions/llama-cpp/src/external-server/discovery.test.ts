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

  it("bypasses the shared cache for credential-scoped discovery", async () => {
    discoverRowsMock.mockResolvedValue({
      kind: "success",
      health: "ready",
      fetchedAt: 123,
      rows: [],
    });

    for (let index = 0; index < 2; index += 1) {
      await discoverLlamaServer({
        baseUrl: "http://localhost:8080",
        headers: { Authorization: "Bearer endpoint-key" },
      });
    }

    expect(discoverRowsMock).toHaveBeenCalledTimes(2);
  });
});
