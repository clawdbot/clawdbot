// Ollama probe planning tests cover keyless runtime auth and provider-scoped catalog reads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const loadPreparedModelCatalog = vi.fn(async () => [
  { provider: "ollama", id: "llama3.2:latest" },
  { provider: "ollama", id: "gemma4:latest" },
]);

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
});
