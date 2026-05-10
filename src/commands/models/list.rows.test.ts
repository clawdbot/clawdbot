import { describe, expect, it, vi } from "vitest";
import type { ModelRow } from "./list.types.js";

const mocks = vi.hoisted(() => ({
  shouldSuppressBuiltInModel: vi.fn(() => {
    throw new Error("runtime model suppression should be skipped");
  }),
  shouldSuppressBuiltInModelFromManifest: vi.fn(() => false),
  loadProviderCatalogModelsForList: vi.fn().mockResolvedValue([
    {
      id: "gpt-5.5",
      name: "gpt-5.5",
      provider: "codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text"],
    },
  ]),
}));

vi.mock("../../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModel: mocks.shouldSuppressBuiltInModel,
  shouldSuppressBuiltInModelFromManifest: mocks.shouldSuppressBuiltInModelFromManifest,
}));

vi.mock("./list.provider-catalog.js", () => ({
  loadProviderCatalogModelsForList: mocks.loadProviderCatalogModelsForList,
}));

import { appendProviderCatalogRows } from "./list.rows.js";

const authIndex = {
  hasProviderAuth: (provider: string) => provider === "codex",
  allowsProviderAuthAvailabilityFallback: () => false,
};

function requireOnlyRow(rows: ModelRow[]): ModelRow {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) {
    throw new Error("expected one model row");
  }
  return row;
}

describe("appendProviderCatalogRows", () => {
  it("can skip runtime model-suppression hooks for provider-catalog fast paths", async () => {
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "codex/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex,
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "codex", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(mocks.shouldSuppressBuiltInModel).not.toHaveBeenCalled();
    expect(mocks.shouldSuppressBuiltInModelFromManifest).toHaveBeenCalledWith({
      provider: "codex",
      id: "gpt-5.5",
      config: {
        agents: { defaults: { model: { primary: "codex/gpt-5.5" } } },
        models: { providers: {} },
      },
    });
    const row = requireOnlyRow(rows);
    expect(row.key).toBe("codex/gpt-5.5");
    expect(row.available).toBe(true);
    expect(row.missing).toBe(false);
  });

  it("applies manifest suppression when runtime model-suppression hooks are skipped", async () => {
    mocks.loadProviderCatalogModelsForList.mockResolvedValueOnce([
      {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        input: ["text", "image"],
      },
    ]);
    mocks.shouldSuppressBuiltInModelFromManifest.mockReturnValueOnce(true);
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          hasProviderAuth: () => false,
          allowsProviderAuthAvailabilityFallback: () => false,
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(mocks.shouldSuppressBuiltInModel).not.toHaveBeenCalled();
    expect(mocks.shouldSuppressBuiltInModelFromManifest).toHaveBeenCalledWith({
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
        models: { providers: {} },
      },
    });
    expect(rows).toStrictEqual([]);
  });

  it("uses Codex auth availability for configured canonical OpenAI rows", async () => {
    mocks.loadProviderCatalogModelsForList.mockResolvedValueOnce([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        input: ["text", "image"],
      },
    ]);
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          hasProviderAuth: (provider: string) => provider === "openai",
          allowsProviderAuthAvailabilityFallback: (provider: string) => provider === "openai",
        },
        configuredByKey: new Map([
          [
            "openai/gpt-5.5",
            {
              key: "openai/gpt-5.5",
              ref: { provider: "openai", model: "gpt-5.5" },
              tags: new Set(["configured"]),
              aliases: [],
            },
          ],
        ]),
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        availableKeys: new Set(),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    const row = requireOnlyRow(rows);
    expect(row.key).toBe("openai/gpt-5.5");
    expect(row.available).toBe(true);
    expect(row.tags).toEqual(["configured"]);
  });
});
