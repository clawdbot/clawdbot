import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveRuntimeWebToolsMetadata: vi.fn(),
  getActiveSecretsRuntimeSnapshot: vi.fn(),
  resolveManifestContractOwnerPluginId: vi.fn(),
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

describe("web tool runtime context", () => {
  beforeEach(() => {
    mocks.getActiveRuntimeWebToolsMetadata.mockReset();
    mocks.getActiveRuntimeWebToolsMetadata.mockReturnValue(null);
    mocks.getActiveSecretsRuntimeSnapshot.mockReset();
    mocks.getActiveSecretsRuntimeSnapshot.mockReturnValue(null);
    mocks.resolveManifestContractOwnerPluginId.mockReset();
    mocks.resolveManifestContractOwnerPluginId.mockReturnValue(undefined);
  });

  it("late-binds search config and metadata from active runtime before captured options", async () => {
    const runtimeConfig = {
      tools: { web: { search: { provider: "perplexity" } } },
    };
    mocks.getActiveSecretsRuntimeSnapshot.mockReturnValue({ config: runtimeConfig });
    mocks.getActiveRuntimeWebToolsMetadata.mockReturnValue({
      search: {
        providerConfigured: "perplexity",
        providerSource: "configured",
        selectedProvider: "perplexity",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics: [],
    });
    const { resolveWebSearchToolRuntimeContext } = await import("./web-tool-runtime-context.js");

    const resolved = resolveWebSearchToolRuntimeContext({
      config: { tools: { web: { search: { provider: "brave" } } } },
      lateBindRuntimeConfig: true,
      runtimeWebSearch: {
        providerConfigured: "brave",
        providerSource: "configured",
        selectedProvider: "brave",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
    });

    expect(resolved.config).toBe(runtimeConfig);
    expect(resolved.runtimeWebSearch).toMatchObject({ selectedProvider: "perplexity" });
    expect(mocks.resolveManifestContractOwnerPluginId).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "webSearchProviders",
        value: "perplexity",
      }),
    );
  });

  it("falls back to captured search config and runtime metadata when active globals are missing", async () => {
    const capturedConfig = {
      tools: { web: { search: { provider: "brave" } } },
    };
    const { resolveWebSearchToolRuntimeContext } = await import("./web-tool-runtime-context.js");

    const resolved = resolveWebSearchToolRuntimeContext({
      config: capturedConfig,
      lateBindRuntimeConfig: true,
      runtimeWebSearch: {
        providerConfigured: "brave",
        providerSource: "configured",
        selectedProvider: "brave",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
    });

    expect(resolved.config).toBe(capturedConfig);
    expect(resolved.runtimeWebSearch).toMatchObject({ selectedProvider: "brave" });
    expect(mocks.resolveManifestContractOwnerPluginId).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "webSearchProviders",
        value: "brave",
      }),
    );
  });

  it("uses configured provider ids when runtime metadata is absent", async () => {
    const { resolveWebSearchToolRuntimeContext } = await import("./web-tool-runtime-context.js");

    resolveWebSearchToolRuntimeContext({
      config: { tools: { web: { search: { provider: "Brave" } } } },
    });

    expect(mocks.resolveManifestContractOwnerPluginId).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "webSearchProviders",
        value: "brave",
      }),
    );
  });

  it("keeps runtime providers disabled for bundled fetch owners", async () => {
    mocks.resolveManifestContractOwnerPluginId.mockReturnValue("firecrawl");
    const { resolveWebFetchToolRuntimeContext } = await import("./web-tool-runtime-context.js");

    const resolved = resolveWebFetchToolRuntimeContext({
      config: { tools: { web: { fetch: { provider: "firecrawl" } } } },
    });

    expect(resolved.preferRuntimeProviders).toBe(false);
    expect(mocks.resolveManifestContractOwnerPluginId).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "webFetchProviders",
        value: "firecrawl",
      }),
    );
  });

  it("keeps runtime provider discovery enabled when no provider is selected", async () => {
    const { resolveWebFetchToolRuntimeContext } = await import("./web-tool-runtime-context.js");

    const resolved = resolveWebFetchToolRuntimeContext({
      config: {},
    });

    expect(resolved.preferRuntimeProviders).toBe(true);
    expect(mocks.resolveManifestContractOwnerPluginId).not.toHaveBeenCalled();
  });
});
