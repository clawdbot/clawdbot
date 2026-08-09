import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPersistedPluginModelCatalogsReadOnly: vi.fn(),
  isGeneratedPluginModelCatalog: vi.fn(
    (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      (value as { generatedBy?: unknown }).generatedBy === "openclaw-plugin-model-catalog-v1",
  ),
  filterGeneratedPluginModelCatalogProviders: vi.fn(
    ({ providers }: { providers: Record<string, unknown> }) => providers,
  ),
}));

vi.mock("../../agents/plugin-model-catalog.js", () => ({
  loadPersistedPluginModelCatalogsReadOnly: mocks.loadPersistedPluginModelCatalogsReadOnly,
  isGeneratedPluginModelCatalog: mocks.isGeneratedPluginModelCatalog,
  filterGeneratedPluginModelCatalogProviders: mocks.filterGeneratedPluginModelCatalogProviders,
}));

import { loadPersistedListCatalogEntries } from "./list.persisted-catalog.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadPersistedListCatalogEntries", () => {
  it("projects valid generated provider rows with provider transport defaults", () => {
    mocks.loadPersistedPluginModelCatalogsReadOnly.mockReturnValueOnce([
      {
        pluginId: "openai",
        contents: JSON.stringify({
          generatedBy: "openclaw-plugin-model-catalog-v1",
          providers: {
            openai: {
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [
                {
                  id: "gpt-5.6",
                  name: "GPT-5.6",
                  input: ["text", "image", "invalid"],
                  reasoning: true,
                  contextWindow: 400_000,
                },
              ],
            },
          },
        }),
      },
    ]);

    expect(
      loadPersistedListCatalogEntries({
        agentDir: "/tmp/openclaw-agent",
        providerIds: new Set(["openai"]),
      }),
    ).toEqual([
      {
        provider: "openai",
        id: "gpt-5.6",
        name: "GPT-5.6",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 400_000,
      },
    ]);
  });

  it("skips malformed, unscoped, and transportless rows", () => {
    mocks.loadPersistedPluginModelCatalogsReadOnly.mockReturnValueOnce([
      { pluginId: "bad-json", contents: "{" },
      {
        pluginId: "catalog",
        contents: JSON.stringify({
          generatedBy: "openclaw-plugin-model-catalog-v1",
          providers: {
            openai: { models: [{ id: "missing-api" }] },
            google: {
              api: "google-generative-ai",
              models: [{ id: "gemini-live" }],
            },
          },
        }),
      },
    ]);

    expect(
      loadPersistedListCatalogEntries({
        agentDir: "/tmp/openclaw-agent",
        providerIds: new Set(["openai"]),
      }),
    ).toEqual([]);
  });
});
