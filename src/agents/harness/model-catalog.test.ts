import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { ModelCatalogSnapshot } from "../model-catalog.types.js";
import { augmentModelCatalogWithAgentHarness } from "./model-catalog.js";

const cfg = {
  agents: {
    defaults: { model: { primary: "openai/gpt-5.6-sol" } },
    list: [
      {
        id: "main",
        default: true,
        models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
      },
    ],
  },
} as OpenClawConfig;

const snapshot: ModelCatalogSnapshot = {
  entries: [],
  routeVariants: [
    {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol (API)",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
  ],
  staticEntries: [
    {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextWindow: 1_050_000,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    },
  ],
};

function registryWithCatalog(loadModelCatalog: () => Promise<readonly never[]>) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "codex",
    source: "test",
    harness: {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
      loadModelCatalog,
    } as never,
  });
  return registry;
}

describe("agent harness model catalog", () => {
  it("merges account-scoped harness models into the prepared generation", async () => {
    const loadModelCatalog = vi.fn(async () => [
      {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol (account)",
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    ]);

    const result = await augmentModelCatalogWithAgentHarness({
      cfg,
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
      defaultProvider: "anthropic",
      defaultModel: "openai/gpt-5.6-sol",
      snapshot,
      pluginRegistry: registryWithCatalog(loadModelCatalog as never),
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(result.entries[1]).toMatchObject({
      name: "GPT-5.6 Sol (account)",
      contextWindow: 1_050_000,
    });
    expect(result.routeVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6-sol", api: "openai-chatgpt-responses" }),
        expect.objectContaining({ id: "gpt-5.6-sol", api: "openai-responses" }),
      ]),
    );
    expect(loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
    });
  });

  it("keeps prepared rows when harness discovery fails", async () => {
    const onError = vi.fn();
    const result = await augmentModelCatalogWithAgentHarness({
      cfg,
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
      defaultProvider: "anthropic",
      defaultModel: "openai/gpt-5.6-sol",
      snapshot,
      pluginRegistry: registryWithCatalog(async () => {
        throw new Error("model/list unavailable");
      }),
      onError,
    });

    expect(result).toBe(snapshot);
    expect(onError).toHaveBeenCalledOnce();
  });
});
