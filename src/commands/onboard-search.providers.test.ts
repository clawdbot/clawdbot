import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

const mocks = vi.hoisted(() => ({
  resolvePluginWebSearchProviders: vi.fn<
    (params?: { config?: OpenClawConfig }) => PluginWebSearchProviderEntry[]
  >(() => []),
  resolveWebSearchInstallCatalogEntries: vi.fn(() => []),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: mocks.resolvePluginWebSearchProviders,
}));

vi.mock("../plugins/web-search-install-catalog.js", () => ({
  resolveWebSearchInstallCatalogEntries: mocks.resolveWebSearchInstallCatalogEntries,
}));

function createCustomProviderEntry(): PluginWebSearchProviderEntry {
  return {
    id: "custom-search" as never,
    pluginId: "custom-plugin",
    label: "Custom Search",
    hint: "Custom provider",
    onboardingScopes: ["text-inference"],
    envVars: ["CUSTOM_SEARCH_API_KEY"],
    placeholder: "custom-...",
    signupUrl: "https://example.com/custom",
    credentialPath: "plugins.entries.custom-plugin.config.webSearch.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: (config) =>
      (
        config?.plugins?.entries?.["custom-plugin"]?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined
      )?.webSearch?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      const entries = ((configTarget.plugins ??= {}).entries ??= {});
      const pluginEntry = (entries["custom-plugin"] ??= {});
      const pluginConfig = ((pluginEntry as Record<string, unknown>).config ??= {}) as Record<
        string,
        unknown
      >;
      const webSearch = (pluginConfig.webSearch ??= {}) as Record<string, unknown>;
      webSearch.apiKey = value;
    },
    createTool: () => null,
  };
}

function createBundledFirecrawlEntry(): PluginWebSearchProviderEntry {
  return {
    id: "firecrawl",
    pluginId: "firecrawl",
    label: "Firecrawl Search",
    hint: "Structured results",
    onboardingScopes: ["text-inference"],
    envVars: ["FIRECRAWL_API_KEY"],
    placeholder: "fc-...",
    signupUrl: "https://example.com/firecrawl",
    credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: (config) =>
      (
        config?.plugins?.entries?.firecrawl?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined
      )?.webSearch?.apiKey,
    setConfiguredCredentialValue: () => {},
    createTool: () => null,
  };
}

function createBundledDuckDuckGoEntry(): PluginWebSearchProviderEntry {
  return {
    id: "duckduckgo",
    pluginId: "duckduckgo",
    label: "DuckDuckGo Search (experimental)",
    hint: "Free fallback",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://duckduckgo.com/",
    credentialPath: "",
    getCredentialValue: () => "duckduckgo-no-key-needed",
    setCredentialValue: () => {},
    createTool: () => null,
  };
}

describe("onboard-search provider resolution", () => {
  let mod: typeof import("./onboard-search.js");

  beforeAll(async () => {
    mod = await import("./onboard-search.js");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses config-aware non-bundled provider hooks when resolving existing keys", () => {
    const customEntry = createCustomProviderEntry();
    mocks.resolvePluginWebSearchProviders.mockImplementation((params) =>
      params?.config ? [customEntry] : [],
    );

    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "custom-search" as never,
          },
        },
      },
      plugins: {
        entries: {
          "custom-plugin": {
            config: {
              webSearch: {
                apiKey: "custom-key",
              },
            },
          },
        },
      },
    };

    expect(mod.hasExistingKey(cfg, "custom-search" as never)).toBe(true);
    expect(mod.resolveExistingKey(cfg, "custom-search" as never)).toBe("custom-key");

    const updated = mod.applySearchKey(cfg, "custom-search" as never, "next-key");
    expect(
      (
        updated.plugins?.entries?.["custom-plugin"]?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined
      )?.webSearch?.apiKey,
    ).toBe("next-key");
  });

  it("uses config-aware non-bundled providers when building secret refs", async () => {
    const customEntry = createCustomProviderEntry();
    mocks.resolvePluginWebSearchProviders.mockImplementation((params) =>
      params?.config ? [customEntry] : [],
    );

    const cfg: OpenClawConfig = {
      plugins: {
        installs: {
          "custom-plugin": {
            installPath: "/tmp/custom-plugin",
            source: "path",
          },
        },
      },
    };
    const notes: Array<{ title?: string; message: string }> = [];
    const prompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async (message: string, title?: string) => {
        notes.push({ title, message });
      }),
      select: vi.fn(async () => "custom-search"),
      multiselect: vi.fn(async () => []),
      text: vi.fn(async () => ""),
      confirm: vi.fn(async () => true),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const result = await mod.setupSearch(cfg, {} as never, prompter as never, {
      secretInputMode: "ref",
    });

    expect(result.tools?.web?.search?.provider).toBe("custom-search");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(
      (
        result.plugins?.entries?.["custom-plugin"]?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined
      )?.webSearch?.apiKey,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "CUSTOM_SEARCH_API_KEY",
    });
    expect(notes.map((note) => note.message).join("\n")).toContain("CUSTOM_SEARCH_API_KEY");
  });

  it("does not treat hard-disabled bundled providers as selectable credentials", () => {
    mocks.resolvePluginWebSearchProviders.mockReturnValue([]);

    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "firecrawl",
          },
        },
      },
      plugins: {
        enabled: false,
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: "fc-disabled-key",
              },
            },
          },
        },
      },
    };

    expect(mod.hasExistingKey(cfg, "firecrawl")).toBe(false);
    expect(mod.resolveExistingKey(cfg, "firecrawl")).toBeUndefined();
    expect(mod.applySearchProviderSelection(cfg, "firecrawl")).toBe(cfg);
  });

  it("defaults to a keyless provider when no search credentials exist", async () => {
    const duckduckgoEntry = createBundledDuckDuckGoEntry();
    mocks.resolvePluginWebSearchProviders.mockImplementation((params) =>
      params?.config ? [duckduckgoEntry] : [duckduckgoEntry],
    );

    const notes: string[] = [];
    const prompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async (message: string) => {
        notes.push(message);
      }),
      select: vi.fn(async () => "duckduckgo"),
      multiselect: vi.fn(async () => []),
      text: vi.fn(async () => {
        throw new Error("text prompt should not run for keyless providers");
      }),
      confirm: vi.fn(async () => true),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const result = await mod.setupSearch({} as OpenClawConfig, {} as never, prompter as never);

    expect(result.tools?.web?.search?.provider).toBe("duckduckgo");
    expect(result.plugins?.entries?.duckduckgo?.enabled).toBe(true);
    expect(notes.join("\n")).toContain("works without an API key");
  });

  it("uses the runtime onboarding search surface when no config is present", () => {
    const firecrawlEntry = createBundledFirecrawlEntry();
    const duckduckgoEntry = createBundledDuckDuckGoEntry();
    const tavilyEntry: PluginWebSearchProviderEntry = {
      ...firecrawlEntry,
      id: "tavily",
      pluginId: "tavily",
      label: "Tavily Search",
      hint: "Research search",
      envVars: ["TAVILY_API_KEY"],
      signupUrl: "https://example.com/tavily",
      credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
    };
    const customEntry = createCustomProviderEntry();

    mocks.resolvePluginWebSearchProviders.mockReturnValue([
      customEntry,
      duckduckgoEntry,
      firecrawlEntry,
      tavilyEntry,
    ]);

    const options = mod.resolveSearchProviderOptions();

    expect(options.map((entry) => entry.id)).toEqual([
      "custom-search",
      "duckduckgo",
      "firecrawl",
      "tavily",
    ]);
  });
});
