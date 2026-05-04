import { beforeEach, describe, expect, it, vi } from "vitest";

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
    const { createWebSearchTool } = await import("./web-search.js");
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

    expect(mocks.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeWebSearch: expect.objectContaining({ selectedProvider: "brave" }),
      }),
    );
  });

  it("falls back to options.config when getActiveSecretsRuntimeSnapshot is null", async () => {
    const { createWebSearchTool } = await import("./web-search.js");
    const fallbackConfig = {
      tools: { web: { search: { provider: "brave" } } },
    };
    const tool = createWebSearchTool({
      config: fallbackConfig,
      lateBindRuntimeConfig: true,
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(mocks.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        config: fallbackConfig,
      }),
    );
  });

  it("uses configured provider id from config when no runtime selection is present", async () => {
    const { createWebSearchTool } = await import("./web-search.js");
    const config = {
      tools: { web: { search: { provider: "Brave" } } },
    };
    const tool = createWebSearchTool({
      config,
      lateBindRuntimeConfig: true,
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(mocks.resolveManifestContractOwnerPluginId).toHaveBeenCalledWith(
      expect.objectContaining({ value: "brave" }),
    );
    expect(mocks.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ preferRuntimeProviders: true }),
    );
  });

  it("keeps runtime provider discovery enabled when no provider id is selected anywhere", async () => {
    const { createWebSearchTool } = await import("./web-search.js");
    const tool = createWebSearchTool({
      config: {},
      lateBindRuntimeConfig: true,
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(mocks.resolveManifestContractOwnerPluginId).not.toHaveBeenCalled();
    expect(mocks.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ preferRuntimeProviders: true }),
    );
  });

  it("does not prefer runtime providers when the configured provider is a bundled manifest owner", async () => {
    mocks.resolveManifestContractOwnerPluginId.mockReturnValue("openclaw-bundled-brave");
    const { createWebSearchTool } = await import("./web-search.js");
    const config = {
      tools: { web: { search: { provider: "brave" } } },
    };
    const tool = createWebSearchTool({
      config,
      lateBindRuntimeConfig: true,
    });

    await tool?.execute("call-search", { query: "openclaw" }, undefined);

    expect(mocks.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ preferRuntimeProviders: false }),
    );
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
    const { createWebSearchTool } = await import("./web-search.js");
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

    expect(mocks.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeWebSearch: expect.objectContaining({ selectedProvider: "perplexity" }),
      }),
    );
  });
});
