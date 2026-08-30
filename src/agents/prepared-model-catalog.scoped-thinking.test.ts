// Turn-path thinking reuses published facts before manifest/scoped discovery fallback.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import * as providerModelNormalizationRuntime from "./provider-model-normalization.runtime.js";

const manifestCatalogMock = vi.fn((..._args: unknown[]): Array<Record<string, unknown>> => []);
const scopedStaticMock = vi.fn(
  async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    entries: [],
    routeVariants: [],
  }),
);
const scopedLiveMock = vi.fn(
  async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    entries: [],
    routeVariants: [],
  }),
);
const publishedSnapshotMock = vi.fn((..._args: unknown[]) => undefined as unknown);

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: (...args: unknown[]) => manifestCatalogMock(...args),
}));

vi.mock("./prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./prepared-model-runtime.js")>();
  return {
    ...actual,
    getPreparedModelRuntimeSnapshot: (...args: unknown[]) => publishedSnapshotMock(...args),
    // No published lifecycle owner: force the scoped read-only builders to run.
    prepareModelRuntimeSnapshot: vi.fn(async (input: { agentDir: string }) => {
      throw new actual.PreparedModelRuntimeOwnerNotPublishedError(
        `not published for test (${input.agentDir})`,
      );
    }),
  };
});

vi.mock("./prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyModelCatalog: (...args: unknown[]) => scopedStaticMock(...args),
  prepareScopedReadOnlyLiveModelCatalog: (...args: unknown[]) => scopedLiveMock(...args),
}));

const ollamaEntry = {
  provider: "ollama",
  id: "minimax-m3:cloud",
  name: "minimax-m3:cloud",
  reasoning: true,
};

describe("loadProviderScopedThinkingCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manifestCatalogMock.mockReturnValue([]);
    scopedStaticMock.mockResolvedValue({ entries: [], routeVariants: [] });
    scopedLiveMock.mockResolvedValue({ entries: [], routeVariants: [] });
    publishedSnapshotMock.mockReturnValue(undefined);
  });

  it("prefers the published prepared generation over partial manifest compatibility", async () => {
    manifestCatalogMock.mockReturnValue([
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      },
    ]);
    publishedSnapshotMock.mockImplementation((input: unknown) => ({
      config: (input as { config: unknown }).config,
      modelCatalog: {
        entries: [
          {
            provider: "openai",
            id: "gpt-5.6-sol",
            reasoning: true,
            compat: {
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
            },
          },
        ],
        routeVariants: [],
      },
    }));
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");

    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      provider: "openai",
      model: "gpt-5.6-sol",
    });

    expect(catalog[0]?.compat?.supportedReasoningEfforts).toContain("ultra");
    expect(manifestCatalogMock).not.toHaveBeenCalled();
    expect(scopedStaticMock).not.toHaveBeenCalled();
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });

  it("keeps the selected model tuple when augmenting thinking from its harness", async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          main: {
            models: {
              "thinking-provider/selected-model": {
                agentRuntime: { id: "thinking-catalog" },
              },
            },
          },
        },
      },
    };
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const entry = {
      provider: "thinking-provider",
      id: "selected-model",
      name: "Selected model",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low"] },
    };
    publishedSnapshotMock.mockReturnValue({
      config,
      metadataSnapshot,
      modelCatalog: { entries: [entry], routeVariants: [] },
    });
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "thinking-catalog",
      source: "test",
      harness: {
        id: "thinking-catalog",
        label: "Thinking catalog",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("catalog fixture must not execute a turn");
        },
        loadModelCatalog: async () => [
          {
            ...entry,
            name: "Selected harness model",
            compat: { supportedReasoningEfforts: ["high"] },
          },
        ],
      },
    });
    const previousRegistry = captureActivePluginRegistrySnapshot();
    const normalize = vi
      .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
      .mockImplementation(({ provider, context }) =>
        provider === entry.provider ? `${context.modelId}-renormalized` : undefined,
      );
    try {
      stageActivePluginRegistry(registry, null, "default");
      const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
      const catalog = await withPluginRuntimeGenerationScope(
        { config, metadataSnapshot, pluginRegistry: registry },
        () =>
          loadProviderScopedThinkingCatalog({
            config,
            agentId: "main",
            agentDir: "/tmp/thinking-catalog-agent",
            workspaceDir: "/tmp/thinking-catalog-workspace",
            provider: entry.provider,
            model: entry.id,
          }),
      );
      expect(catalog).toContainEqual(
        expect.objectContaining({
          provider: entry.provider,
          id: entry.id,
          name: "Selected harness model",
          compat: expect.objectContaining({ supportedReasoningEfforts: ["low", "high"] }),
        }),
      );
    } finally {
      normalize.mockRestore();
      rollbackStagedPluginRegistry(previousRegistry);
    }
  });

  it("resolves manifest-backed models without any scoped catalog build", async () => {
    manifestCatalogMock.mockReturnValue([
      { provider: "openai", id: "gpt-5.6-luna", reasoning: true },
    ]);
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(catalog).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.6-luna", reasoning: true }),
    ]);
    expect(scopedStaticMock).not.toHaveBeenCalled();
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });

  it("stops at the scoped static catalog when it resolves the entry", async () => {
    scopedStaticMock.mockResolvedValue({
      entries: [{ provider: "acme", id: "static-model", reasoning: false }],
      routeVariants: [],
    });
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      provider: "acme",
      model: "static-model",
    });
    expect(catalog).toEqual([
      expect.objectContaining({ provider: "acme", id: "static-model", reasoning: false }),
    ]);
    expect(scopedStaticMock).toHaveBeenCalledTimes(1);
    expect(scopedStaticMock).toHaveBeenCalledWith(expect.anything(), ["acme"]);
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });

  it("runs provider-scoped live discovery for runtime-only models and keeps their thinking", async () => {
    scopedLiveMock.mockResolvedValue({ entries: [ollamaEntry], routeVariants: [] });
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      provider: "ollama",
      model: "minimax-m3:cloud",
    });
    expect(catalog).toEqual([expect.objectContaining(ollamaEntry)]);
    // Live discovery stays scoped to the requested provider: no broad plugin fanout.
    expect(scopedLiveMock).toHaveBeenCalledTimes(1);
    expect(scopedLiveMock).toHaveBeenCalledWith(expect.anything(), ["ollama"]);
    expect(scopedStaticMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "prepared vision",
      input: ["text", "image"],
      expected: ["text", "image"],
      source: "published",
    },
    { name: "prepared text-only", input: ["text"], expected: ["text"], source: "published" },
    { name: "reasoning-only published row", expected: ["text", "image"], source: "manifest" },
    {
      name: "different prepared and manifest route",
      input: ["text", "image"],
      expected: ["text"],
      source: "scoped",
      customRoute: true,
    },
  ])("resolves input independently of reasoning: $name", async (testCase) => {
    const base = {
      provider: "acme",
      id: "selected",
      name: "Selected",
      reasoning: true,
      api: "openai-responses" as const,
      baseUrl: "https://provider.invalid/v1",
    };
    const requiredInputRoute = {
      api: base.api,
      baseUrl: testCase.customRoute ? "https://custom.invalid/v1" : base.baseUrl,
    };
    publishedSnapshotMock.mockImplementation((input: unknown) => ({
      config: (input as { config: unknown }).config,
      modelCatalog: { entries: [{ ...base, input: testCase.input }], routeVariants: [] },
    }));
    manifestCatalogMock.mockReturnValue([{ ...base, input: ["text", "image"] }]);
    scopedStaticMock.mockResolvedValue({
      entries: [{ ...base, ...requiredInputRoute, input: ["text"] }],
      routeVariants: [],
    });
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      provider: "acme",
      model: "selected",
      requiredInputRoute,
    });
    expect(catalog.find((entry) => entry.id === "selected")?.input).toEqual(testCase.expected);
    expect(manifestCatalogMock).toHaveBeenCalledTimes(testCase.source === "published" ? 0 : 1);
    expect(scopedStaticMock).toHaveBeenCalledTimes(testCase.source === "scoped" ? 1 : 0);
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });
});
