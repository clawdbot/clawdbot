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
  entries: [
    {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol (API)",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    },
  ],
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
      reasoning: true,
      params: { providerFact: "kept", codexAppServerRuntimeModel: "stale-runtime" },
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        supportsTools: false,
      },
    },
    {
      provider: "openai",
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    },
    {
      provider: "openai",
      id: "provider-empty-reasoner",
      name: "Provider Empty Reasoner",
      compat: { supportedReasoningEfforts: [] },
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
  it.each([false, true])(
    "does not donate host transport or capabilities to native-owned rows (host sibling: %s)",
    async (includeHostRow) => {
      const native = {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "Native model",
        nativeRuntime: "codex",
        reasoning: true,
      };
      const host = { provider: "openai", id: "gpt-5.6-terra", name: "Host model" };
      const result = await augmentModelCatalogWithAgentHarness({
        cfg,
        agentId: "main",
        agentDir: "/tmp/main-agent",
        workspaceDir: "/tmp/workspace",
        defaultProvider: "openai",
        defaultModel: "openai/gpt-5.6-sol",
        snapshot,
        pluginRegistry: registryWithCatalog(
          async () => (includeHostRow ? [native, host] : [native]) as never,
        ),
      });
      expect(result.entries[0]).toEqual(native);
      expect(result.routeVariants[0]).toEqual(native);
      if (includeHostRow) {
        expect(result.entries[1]).toMatchObject({
          id: "gpt-5.6-terra",
          name: "Host model",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          reasoning: true,
        });
      }
    },
  );
  it("merges account-scoped harness models into the prepared generation", async () => {
    const loadModelCatalog = vi.fn(async () => [
      {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: false,
        compat: { supportedReasoningEfforts: [] },
      },
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol (account)",
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        params: { codexAppServerRuntimeModel: "gpt-5.6-sol-runtime" },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["high", "ultra"],
          supportsTools: true,
        },
      },
      {
        provider: "openai",
        id: "custom-reasoner",
        name: "Custom Reasoner",
        compat: { supportedReasoningEfforts: ["high"] },
      },
      {
        provider: "openai",
        id: "provider-empty-reasoner",
        name: "Provider Empty Reasoner",
        compat: { supportedReasoningEfforts: ["high"] },
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

    expect(result.entries.map((entry) => entry.id)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "custom-reasoner",
      "provider-empty-reasoner",
    ]);
    expect(result.entries[0]?.compat?.supportedReasoningEfforts).toEqual([]);
    expect(result.entries[1]).toMatchObject({
      name: "GPT-5.6 Sol (account)",
      contextWindow: 1_050_000,
      params: {
        providerFact: "kept",
        codexAppServerRuntimeModel: "gpt-5.6-sol-runtime",
      },
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        supportsTools: true,
      },
    });
    expect(result.entries[2]?.compat?.supportedReasoningEfforts).toEqual(["high"]);
    expect(result.entries[3]?.compat?.supportedReasoningEfforts).toEqual(["high"]);
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
      configuredModelRefs: [
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "openai", model: "gpt-5.6-sol" },
      ],
    });
  });

  it("prepares configured refs for the selected agent without including other agents", async () => {
    const selectedConfig: OpenClawConfig = {
      agents: {
        defaults: cfg.agents?.defaults,
        entries: {
          main: {
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
              "openai/synthetic-configured": {},
            },
          },
          another: { model: { primary: "openai/synthetic-other-agent" } },
        },
      },
    };
    const loadModelCatalog = vi.fn(async () => []);
    await augmentModelCatalogWithAgentHarness({
      cfg: selectedConfig,
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
      defaultProvider: "anthropic",
      defaultModel: "openai/gpt-5.6-sol",
      snapshot,
      pluginRegistry: registryWithCatalog(loadModelCatalog),
    });

    expect(loadModelCatalog).toHaveBeenCalledExactlyOnceWith({
      config: selectedConfig,
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
      configuredModelRefs: [
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "openai", model: "synthetic-configured" },
      ],
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
