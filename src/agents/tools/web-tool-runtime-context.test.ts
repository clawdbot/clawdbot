import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveWebFetchToolRuntimeContext,
  resolveWebSearchToolRuntimeContext,
} from "./web-tool-runtime-context.js";

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

function latestOwnerLookupParams(): Record<string, unknown> {
  const params = mocks.resolveManifestContractOwnerPluginId.mock.calls.at(-1)?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("expected owner lookup params");
  }
  return params as Record<string, unknown>;
}

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
    expect(resolved.runtimeWebSearch?.selectedProvider).toBe("perplexity");
    const ownerLookup = latestOwnerLookupParams();
    expect(ownerLookup.contract).toBe("webSearchProviders");
    expect(ownerLookup.value).toBe("perplexity");
    expect(ownerLookup.origin).toBe("bundled");
    expect(ownerLookup.config).toBe(runtimeConfig);
  });

  it("falls back to captured search config and runtime metadata when active globals are missing", async () => {
    const capturedConfig = {
      tools: { web: { search: { provider: "brave" } } },
    };

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
    expect(resolved.runtimeWebSearch?.selectedProvider).toBe("brave");
    const ownerLookup = latestOwnerLookupParams();
    expect(ownerLookup.contract).toBe("webSearchProviders");
    expect(ownerLookup.value).toBe("brave");
    expect(ownerLookup.origin).toBe("bundled");
    expect(ownerLookup.config).toBe(capturedConfig);
  });

  it("uses configured provider ids when runtime metadata is absent", () => {
    resolveWebSearchToolRuntimeContext({
      config: { tools: { web: { search: { provider: "Brave" } } } },
    });

    const ownerLookup = latestOwnerLookupParams();
    expect(ownerLookup.contract).toBe("webSearchProviders");
    expect(ownerLookup.value).toBe("brave");
    expect(ownerLookup.origin).toBe("bundled");
    expect(ownerLookup.config).toEqual({
      tools: { web: { search: { provider: "Brave" } } },
    });
  });

  it("keeps runtime providers disabled for bundled fetch owners", async () => {
    mocks.resolveManifestContractOwnerPluginId.mockReturnValue("firecrawl");

    const resolved = resolveWebFetchToolRuntimeContext({
      config: { tools: { web: { fetch: { provider: "firecrawl" } } } },
    });

    expect(resolved.preferRuntimeProviders).toBe(false);
    const ownerLookup = latestOwnerLookupParams();
    expect(ownerLookup.contract).toBe("webFetchProviders");
    expect(ownerLookup.value).toBe("firecrawl");
    expect(ownerLookup.origin).toBe("bundled");
    expect(ownerLookup.config).toEqual({
      tools: { web: { fetch: { provider: "firecrawl" } } },
    });
  });

  it("keeps runtime provider discovery enabled when no provider is selected", () => {
    const resolved = resolveWebFetchToolRuntimeContext({
      config: {},
    });

    expect(resolved.preferRuntimeProviders).toBe(true);
    expect(mocks.resolveManifestContractOwnerPluginId).not.toHaveBeenCalled();
  });
});
