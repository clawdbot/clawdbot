import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin, WebFetchProviderPlugin, WebSearchProviderPlugin } from "../types.js";

type MockPluginRecord = {
  id: string;
  status: "loaded" | "error";
  error?: string;
  providerIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
};

type MockRuntimeRegistry = {
  plugins: MockPluginRecord[];
  diagnostics: Array<{ pluginId?: string; message: string }>;
  providers: Array<{ pluginId: string; provider: ProviderPlugin }>;
  webFetchProviders: Array<{ pluginId: string; provider: WebFetchProviderPlugin }>;
  webSearchProviders: Array<{ pluginId: string; provider: WebSearchProviderPlugin }>;
};

function createMockRuntimeRegistry(params: {
  plugin: MockPluginRecord;
  providers?: Array<{ pluginId: string; provider: ProviderPlugin }>;
  webFetchProviders?: Array<{ pluginId: string; provider: WebFetchProviderPlugin }>;
  webSearchProviders?: Array<{ pluginId: string; provider: WebSearchProviderPlugin }>;
  diagnostics?: Array<{ pluginId?: string; message: string }>;
}): MockRuntimeRegistry {
  return {
    plugins: [params.plugin],
    diagnostics: params.diagnostics ?? [],
    providers: params.providers ?? [],
    webFetchProviders: params.webFetchProviders ?? [],
    webSearchProviders: params.webSearchProviders ?? [],
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("plugin contract registry scoped retries", () => {
  it("retries provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            status: "error",
            error: "transient xai load failure",
            providerIds: [],
            webFetchProviderIds: [],
            webSearchProviderIds: [],
          },
          diagnostics: [{ pluginId: "xai", message: "transient xai load failure" }],
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            status: "loaded",
            providerIds: ["xai"],
            webFetchProviderIds: [],
            webSearchProviderIds: ["grok"],
          },
          providers: [
            {
              pluginId: "xai",
              provider: {
                id: "xai",
                label: "xAI",
                docsPath: "/providers/xai",
                auth: [],
              } as ProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveProviderContractProvidersForPluginIds } = await import("./registry.js");

    expect(
      resolveProviderContractProvidersForPluginIds(["xai"]).map((provider) => provider.id),
    ).toEqual(["xai"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });

  it("retries web search provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            status: "error",
            error: "transient grok load failure",
            providerIds: [],
            webFetchProviderIds: [],
            webSearchProviderIds: [],
          },
          diagnostics: [{ pluginId: "xai", message: "transient grok load failure" }],
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            status: "loaded",
            providerIds: ["xai"],
            webFetchProviderIds: [],
            webSearchProviderIds: ["grok"],
          },
          webSearchProviders: [
            {
              pluginId: "xai",
              provider: {
                id: "grok",
                label: "Grok Search",
                hint: "Search the web with Grok",
                envVars: ["XAI_API_KEY"],
                placeholder: "XAI_API_KEY",
                signupUrl: "https://x.ai",
                credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
                requiresCredential: true,
                getCredentialValue: () => undefined,
                setCredentialValue() {},
                createTool: () => ({
                  description: "search",
                  parameters: {},
                  execute: async () => ({}),
                }),
              } as WebSearchProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveWebSearchProviderContractEntriesForPluginId } = await import("./registry.js");

    expect(
      resolveWebSearchProviderContractEntriesForPluginId("xai").map((entry) => entry.provider.id),
    ).toEqual(["grok"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });

  it("reuses the single registered provider contract for paired manifest alias ids", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi.fn().mockReturnValue(
      createMockRuntimeRegistry({
        plugin: {
          id: "byteplus",
          status: "loaded",
          providerIds: ["byteplus"],
          webFetchProviderIds: [],
          webSearchProviderIds: [],
        },
        providers: [
          {
            pluginId: "byteplus",
            provider: {
              id: "byteplus",
              label: "BytePlus",
              docsPath: "/providers/byteplus",
              auth: [],
            } as ProviderPlugin,
          },
        ],
      }),
    );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { requireProviderContractProvider } = await import("./registry.js");

    expect(requireProviderContractProvider("byteplus-plan").id).toBe("byteplus");
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(1);
  });

  it("uses provider public artifacts before falling back to the bundled runtime registry", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi.fn(() => {
      throw new Error("provider contract vitest fast path should not hit bundled runtime registry");
    });
    const loadVitestProviderContractRegistry = vi.fn(() => [
      {
        pluginId: "openai",
        provider: {
          id: "openai",
          label: "OpenAI",
          docsPath: "/providers/openai",
          auth: [
            {
              id: "api-key",
              label: "API key",
              kind: "api_key",
              run: async () => ({ profiles: [] }),
            },
          ],
        } as ProviderPlugin,
      },
      {
        pluginId: "openai",
        provider: {
          id: "openai-codex",
          label: "OpenAI Codex",
          docsPath: "/providers/openai",
          auth: [
            {
              id: "oauth",
              label: "OAuth",
              kind: "oauth",
              run: async () => ({ profiles: [] }),
            },
          ],
        } as ProviderPlugin,
      },
    ]);

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));
    vi.doMock("./provider-vitest-registry.js", () => ({
      loadVitestProviderContractRegistry,
    }));

    const { resolveProviderContractProvidersForPluginIds } = await import("./registry.js");

    expect(
      resolveProviderContractProvidersForPluginIds(["openai"]).map((provider) => provider.id),
    ).toEqual(["openai", "openai-codex"]);
    expect(loadVitestProviderContractRegistry).toHaveBeenCalledTimes(1);
    expect(loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
  });

  it("uses web search public artifacts before falling back to the bundled runtime registry", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi.fn(() => {
      throw new Error(
        "web search contract vitest fast path should not hit bundled runtime registry",
      );
    });
    const loadVitestWebSearchProviderContractRegistry = vi.fn(() => [
      {
        pluginId: "google",
        provider: {
          id: "gemini",
          label: "Gemini",
          credentialPath: "plugins.entries.google.config.webSearch.apiKey",
        } as WebSearchProviderPlugin,
        credentialValue: "AIzaSyDUMMY",
      },
    ]);

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));
    vi.doMock("./web-provider-vitest-registry.js", () => ({
      loadVitestWebSearchProviderContractRegistry,
    }));

    const { resolveWebSearchProviderContractEntriesForPluginId } = await import("./registry.js");

    expect(
      resolveWebSearchProviderContractEntriesForPluginId("google").map(
        (entry) => entry.provider.id,
      ),
    ).toEqual(["gemini"]);
    expect(loadVitestWebSearchProviderContractRegistry).toHaveBeenCalledTimes(1);
    expect(loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
  });

  it("retries web fetch provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "firecrawl",
            status: "error",
            error: "transient firecrawl fetch load failure",
            providerIds: [],
            webFetchProviderIds: [],
            webSearchProviderIds: [],
          },
          diagnostics: [
            { pluginId: "firecrawl", message: "transient firecrawl fetch load failure" },
          ],
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "firecrawl",
            status: "loaded",
            providerIds: [],
            webFetchProviderIds: ["firecrawl"],
            webSearchProviderIds: ["firecrawl"],
          },
          webFetchProviders: [
            {
              pluginId: "firecrawl",
              provider: {
                id: "firecrawl",
                label: "Firecrawl",
                hint: "Fetch with Firecrawl",
                envVars: ["FIRECRAWL_API_KEY"],
                placeholder: "fc-...",
                signupUrl: "https://firecrawl.dev",
                credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
                requiresCredential: true,
                getCredentialValue: () => undefined,
                setCredentialValue() {},
                createTool: () => ({
                  description: "fetch",
                  parameters: {},
                  execute: async () => ({}),
                }),
              } as WebFetchProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveWebFetchProviderContractEntriesForPluginId } = await import("./registry.js");

    expect(
      resolveWebFetchProviderContractEntriesForPluginId("firecrawl").map(
        (entry) => entry.provider.id,
      ),
    ).toEqual(["firecrawl"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });
});
