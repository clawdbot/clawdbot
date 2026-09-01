// Ollama probe planning tests cover keyless runtime auth and provider-scoped catalog reads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildProbeCandidateMap, selectProbeModel } from "./list.probe.models.js";

const loadPreparedModelCatalog = vi.fn(
  async (): Promise<Array<Pick<ModelCatalogEntry, "provider" | "id" | "status">>> => [
    { provider: "ollama", id: "llama3.2:latest" },
    { provider: "ollama", id: "gemma4:latest" },
  ],
);

vi.mock("../../agents/prepared-model-catalog.js", () => ({ loadPreparedModelCatalog }));
vi.mock("../../agents/auth-profiles.js", () => ({
  externalCliDiscoveryScoped: () => undefined,
  ensureAuthProfileStore: () => ({ version: 1, profiles: {}, order: {} }),
  listProfilesForProvider: () => [],
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
}));
vi.mock("../../agents/model-auth.js", () => ({
  hasSyntheticLocalProviderAuthConfig: ({
    cfg,
    provider,
  }: {
    cfg: OpenClawConfig;
    provider: string;
  }) => {
    const configured = cfg.models?.providers?.[provider];
    return (
      provider === "ollama" &&
      configured?.api === "ollama" &&
      configured.apiKey === undefined &&
      configured.baseUrl === "http://127.0.0.1:11434"
    );
  },
  hasUsableCustomProviderApiKey: (cfg: OpenClawConfig, provider: string) =>
    cfg.models?.providers?.[provider]?.apiKey === "ollama-local",
  resolveEnvApiKey: () => null,
  resolveProviderEntryApiKeyBinding: vi.fn(),
  resolveProviderEntryApiKeyProfileReference: ({
    cfg,
    provider,
  }: {
    cfg: OpenClawConfig;
    provider: string;
  }) =>
    cfg.models?.providers?.[provider]?.apiKey === "ollama-local"
      ? { kind: "marker" }
      : { kind: "none" },
  resolveUsableCustomProviderApiKey: ({
    cfg,
    provider,
  }: {
    cfg: OpenClawConfig;
    provider: string;
  }) =>
    cfg.models?.providers?.[provider]?.apiKey === "ollama-local"
      ? { apiKey: "ollama-local", source: "models.json (local marker)" }
      : null,
}));
vi.mock("../../agents/provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider,
}));

const { buildProbeTargets } = await import("./list.probe.js");

const options = {
  includeDirectKeys: true,
  timeoutMs: 5_000,
  concurrency: 1,
  maxTokens: 8,
};

describe("Ollama probe targets", () => {
  beforeEach(() => loadPreparedModelCatalog.mockClear());

  it("builds a runtime-auth target for a configured keyless local provider", async () => {
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    const plan = await buildProbeTargets({
      cfg,
      providers: ["ollama"],
      modelCandidates: ["ollama/gemma4:latest"],
      options,
    });

    expect(plan.results).toEqual([]);
    expect(loadPreparedModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        providerDiscoveryProviderIds: ["ollama"],
      }),
    );
    expect(plan.targets).toEqual([
      {
        provider: "ollama",
        model: { provider: "ollama", model: "gemma4:latest" },
        label: "models.json",
        source: "models.json",
        mode: "api_key",
        useRuntimeAuth: true,
      },
    ]);
  });

  it("presents a local no-auth marker as provider configuration", async () => {
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            apiKey: "ollama-local",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    const plan = await buildProbeTargets({
      cfg,
      providers: ["ollama"],
      modelCandidates: ["ollama/llama3.2:latest"],
      options,
    });

    expect(plan.results).toEqual([]);
    expect(plan.targets).toEqual([
      expect.objectContaining({
        provider: "ollama",
        label: "provider",
        source: "models.json",
        boundValue: "ollama-local",
        useRuntimeAuth: true,
      }),
    ]);
  });

  it("builds an automatic Ollama probe with the first non-retired catalog model", async () => {
    loadPreparedModelCatalog.mockResolvedValueOnce([
      { provider: "ollama", id: "kimi-k2.5", status: "deprecated" },
      { provider: "ollama", id: "kimi-k2.6" },
    ]);

    const plan = await buildProbeTargets({
      cfg: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: [],
            },
          },
        },
      },
      providers: ["ollama"],
      modelCandidates: [],
      options,
    });

    expect(plan.results).toEqual([]);
    expect(plan.targets).toEqual([
      expect.objectContaining({
        provider: "ollama",
        model: { provider: "ollama", model: "kimi-k2.6" },
      }),
    ]);
  });
});

type ProbeModelScenario = {
  name: string;
  provider: string;
  catalog: Array<Pick<ModelCatalogEntry, "provider" | "id" | "status">>;
  requestedModels?: string[];
  expectedModel: string | null;
};

const probeModelScenarios: ProbeModelScenario[] = [
  {
    name: "skips the retired Ollama Cloud catalog model",
    provider: "ollama-cloud",
    catalog: [
      { provider: "ollama-cloud", id: "kimi-k2.5", status: "deprecated" },
      { provider: "ollama-cloud", id: "kimi-k2.6" },
    ],
    expectedModel: "kimi-k2.6",
  },
  {
    name: "skips the retired Tencent preview in favor of its replacement",
    provider: "tencent-tokenhub",
    catalog: [
      { provider: "tencent-tokenhub", id: "hy3-preview", status: "deprecated" },
      { provider: "tencent-tokenhub", id: "hy3" },
    ],
    expectedModel: "hy3",
  },
  {
    name: "skips disabled automatic catalog candidates",
    provider: "ollama",
    catalog: [
      { provider: "ollama", id: "disabled-model", status: "disabled" },
      { provider: "ollama", id: "available-model", status: "available" },
    ],
    expectedModel: "available-model",
  },
  {
    name: "keeps available preview models eligible",
    provider: "ollama",
    catalog: [
      { provider: "ollama", id: "preview-model", status: "preview" },
      { provider: "ollama", id: "available-model", status: "available" },
    ],
    expectedModel: "preview-model",
  },
  {
    name: "reports no model when every automatic candidate is retired",
    provider: "ollama",
    catalog: [
      { provider: "ollama", id: "deprecated-model", status: "deprecated" },
      { provider: "ollama", id: "disabled-model", status: "disabled" },
    ],
    expectedModel: null,
  },
  {
    name: "preserves an explicitly selected retired model",
    provider: "ollama-cloud",
    requestedModels: ["ollama-cloud/kimi-k2.5"],
    catalog: [
      { provider: "ollama-cloud", id: "kimi-k2.5", status: "deprecated" },
      { provider: "ollama-cloud", id: "kimi-k2.6" },
    ],
    expectedModel: "kimi-k2.5",
  },
  {
    name: "does not prioritize a retired Anthropic Haiku over a live Sonnet",
    provider: "anthropic",
    catalog: [
      { provider: "anthropic", id: "claude-haiku-4-5-20251001", status: "deprecated" },
      { provider: "anthropic", id: "claude-sonnet-4-6", status: "available" },
    ],
    expectedModel: "claude-sonnet-4-6",
  },
  {
    name: "preserves the Anthropic Haiku probe priority among eligible models",
    provider: "anthropic",
    catalog: [
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
      { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
    ],
    expectedModel: "claude-haiku-4-5-20251001",
  },
  {
    name: "preserves catalog order for equally prioritized eligible models",
    provider: "ollama",
    catalog: [
      { provider: "ollama", id: "retired-model", status: "deprecated" },
      { provider: "ollama", id: "first-live-model" },
      { provider: "ollama", id: "second-live-model" },
    ],
    expectedModel: "first-live-model",
  },
];

describe("automatic probe model lifecycle", () => {
  it.each(probeModelScenarios)("$name", ({ provider, catalog, requestedModels, expectedModel }) => {
    expect(
      selectProbeModel({
        provider,
        candidates: buildProbeCandidateMap(requestedModels ?? []),
        catalog,
      }),
    ).toEqual(expectedModel === null ? null : { provider, model: expectedModel });
  });
});
