// web_search late-binding tests cover runtime config and provider metadata
// selection at execution time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { createWebSearchTool } from "./web-search.js";

const mocks = vi.hoisted(() => ({
  runWebSearch: vi.fn(),
  resolveManifestContractOwnerPluginId: vi.fn(),
  getActiveRuntimeWebToolsMetadata: vi.fn(),
  getActiveSecretsRuntimeConfigSnapshot: vi.fn(),
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

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: mocks.getActiveSecretsRuntimeConfigSnapshot,
}));

type RunWebSearchParams = {
  config?: unknown;
  preferRuntimeProviders?: boolean;
  runtimeWebSearch?: {
    selectedProvider?: string;
  };
};

function firstRunWebSearchParams(): RunWebSearchParams | undefined {
  return mocks.runWebSearch.mock.calls[0]?.[0] as RunWebSearchParams | undefined;
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
    mocks.getActiveSecretsRuntimeConfigSnapshot.mockReset();
    mocks.getActiveSecretsRuntimeConfigSnapshot.mockReturnValue(null);
  });

  afterEach(() => {
    setActiveDegradedSecretOwners([]);
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

  it("falls back to options.config when getActiveSecretsRuntimeConfigSnapshot is null", async () => {
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

    expect(mocks.resolveManifestContractOwnerPluginId).not.toHaveBeenCalled();
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

  it("keeps runtime provider discovery enabled when configured search provider has a manifest owner", async () => {
    mocks.resolveManifestContractOwnerPluginId.mockReturnValue("openclaw-bundled-brave");
    const config = {
      tools: { web: { search: { provider: "brave" } } },
    };
    const tool = createWebSearchTool({
      config,
      lateBindRuntimeConfig: true,
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(mocks.resolveManifestContractOwnerPluginId).not.toHaveBeenCalled();
    expect(firstRunWebSearchParams()?.preferRuntimeProviders).toBe(true);
  });

  it("prefers active runtime metadata over options.runtimeWebSearch when present", async () => {
    // Active runtime metadata reflects the newest credential snapshot; fallback
    // options only cover tools created before that state exists.
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
    // A long-lived tool must still observe an operator disabling web_search
    // before the next call is dispatched.
    mocks.getActiveSecretsRuntimeConfigSnapshot.mockReturnValue({
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

  it("returns typed unavailability for only the isolated search provider", async () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "web-search:brave",
        state: "unavailable",
        paths: ["tools.web.search.brave.apiKey"],
        refKeys: ["env:default:MISSING_BRAVE_KEY"],
        reason: "missing test ref",
      },
    ]);
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "brave" } } } },
    });

    await expect(
      tool?.execute("call-search", { query: "openclaw" }, undefined),
    ).rejects.toMatchObject({
      name: "SecretSurfaceUnavailableError",
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "capability",
      ownerId: "web-search:brave",
    });
    expect(mocks.runWebSearch).not.toHaveBeenCalled();
  });
});
