import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "./web-search.js";

const mocks = vi.hoisted(() => ({
  runWebSearch: vi.fn(),
  resolveManifestContractOwnerPluginId: vi.fn(),
  getActiveRuntimeWebToolsMetadata: vi.fn(),
  getActiveSecretsRuntimeSnapshot: vi.fn(),
}));

vi.mock("../../web-search/runtime.js", () => ({
  resolveWebSearchProviderId: vi.fn(() => "mock"),
  runWebSearch: mocks.runWebSearch,
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  resolveManifestContractOwnerPluginId: mocks.resolveManifestContractOwnerPluginId,
}));

vi.mock("../../secrets/runtime-web-tools-state.js", () => ({
  getActiveRuntimeWebToolsMetadata: mocks.getActiveRuntimeWebToolsMetadata,
}));

vi.mock("../../secrets/runtime.js", () => ({
  getActiveSecretsRuntimeSnapshot: mocks.getActiveSecretsRuntimeSnapshot,
}));

type RunWebSearchParams = {
  config?: unknown;
  preferRuntimeProviders?: boolean;
  runtimeWebSearch?: {
    selectedProvider?: string;
  };
};

type ProviderResolutionParams = {
  value?: string;
};

function firstRunWebSearchParams(): RunWebSearchParams | undefined {
  return mocks.runWebSearch.mock.calls[0]?.[0] as RunWebSearchParams | undefined;
}

function firstProviderResolutionParams(): ProviderResolutionParams | undefined {
  return mocks.resolveManifestContractOwnerPluginId.mock.calls[0]?.[0] as
    | ProviderResolutionParams
    | undefined;
}

describe("web_search late-bound runtime fallback", () => {
  beforeEach(() => {
    mocks.runWebSearch.mockReset();
    mocks.runWebSearch.mockResolvedValue({
      provider: "brave",
      result: { ok: true },
    });
    mocks.resolveManifestContractOwnerPluginId.mockReset();
    mocks.resolveManifestContractOwnerPluginId.mockReturnValue(undefined);
    mocks.getActiveRuntimeWebToolsMetadata.mockReset();
    mocks.getActiveRuntimeWebToolsMetadata.mockReturnValue(null);
    mocks.getActiveSecretsRuntimeSnapshot.mockReset();
    mocks.getActiveSecretsRuntimeSnapshot.mockReturnValue(null);
  });

  it("falls back to options.runtimeWebSearch when active runtime web tools metadata is absent", async () => {
    const tool = createWebSearchTool({
      config: {},
      lateBindRuntimeConfig: true,
      runtimeWebSearch: {
        selectedProvider: "brave",
        providerConfigured: "brave",
        providerSource: "configured",
        diagnostics: [],
      },
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(firstRunWebSearchParams()?.runtimeWebSearch?.selectedProvider).toBe("brave");
  });

  it("falls back to options.config when getActiveSecretsRuntimeSnapshot is null", async () => {
    const fallbackConfig = {
      tools: { web: { search: { provider: "brave" } } },
    };
    const tool = createWebSearchTool({
      config: fallbackConfig,
      lateBindRuntimeConfig: true,
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(firstRunWebSearchParams()?.config).toBe(fallbackConfig);
  });

  it("uses configured provider id from config when no runtime selection is present", async () => {
    const config = {
      tools: { web: { search: { provider: "Brave" } } },
    };
    const tool = createWebSearchTool({
      config,
      lateBindRuntimeConfig: true,
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(firstProviderResolutionParams()?.value).toBe("brave");
    expect(firstRunWebSearchParams()?.preferRuntimeProviders).toBe(true);
  });

  it("keeps runtime provider discovery enabled when no provider id is selected anywhere", async () => {
    const tool = createWebSearchTool({
      config: {},
      lateBindRuntimeConfig: true,
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(mocks.resolveManifestContractOwnerPluginId).not.toHaveBeenCalled();
    expect(firstRunWebSearchParams()?.preferRuntimeProviders).toBe(true);
  });

  it("does not prefer runtime providers when the configured provider is a bundled manifest owner", async () => {
    mocks.resolveManifestContractOwnerPluginId.mockReturnValue("openclaw-bundled-brave");
    const config = {
      tools: { web: { search: { provider: "brave" } } },
    };
    const tool = createWebSearchTool({
      config,
      lateBindRuntimeConfig: true,
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(firstRunWebSearchParams()?.preferRuntimeProviders).toBe(false);
  });

  it("prefers active runtime metadata over options.runtimeWebSearch when present", async () => {
    mocks.getActiveRuntimeWebToolsMetadata.mockReturnValue({
      search: {
        selectedProvider: "perplexity",
        providerConfigured: "perplexity",
        providerSource: "configured",
        diagnostics: [],
      },
    });
    const tool = createWebSearchTool({
      config: {},
      lateBindRuntimeConfig: true,
      runtimeWebSearch: {
        selectedProvider: "brave",
        providerConfigured: "brave",
        providerSource: "configured",
        diagnostics: [],
      },
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(firstRunWebSearchParams()?.runtimeWebSearch?.selectedProvider).toBe("perplexity");
  });

  it("honors late-bound disabled search config at execute time", async () => {
    mocks.getActiveSecretsRuntimeSnapshot.mockReturnValue({
      config: { tools: { web: { search: { enabled: false } } } },
    });
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "brave" } } } },
      lateBindRuntimeConfig: true,
    });

    await expect(tool?.execute("call-search", { query: "openclaw" }, undefined)).rejects.toThrow(
      "web_search is disabled.",
    );
    expect(mocks.runWebSearch).not.toHaveBeenCalled();
  });
});
