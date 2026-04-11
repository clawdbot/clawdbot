import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { listSearchProviderOptions, setupSearch } from "./onboard-search.js";

type WebSearchConfigRecord = {
  plugins?: {
    entries?: Record<
      string,
      { enabled?: boolean; config?: { webSearch?: Record<string, unknown> } }
    >;
  };
};

const SEARCH_PROVIDER_PLUGINS: Record<
  string,
  { pluginId: string; envVars: string[]; label: string; credentialLabel?: string }
> = {
  brave: { pluginId: "brave", envVars: ["BRAVE_API_KEY"], label: "Brave Search" },
  firecrawl: { pluginId: "firecrawl", envVars: ["FIRECRAWL_API_KEY"], label: "Firecrawl" },
  gemini: { pluginId: "google", envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], label: "Gemini" },
  grok: { pluginId: "xai", envVars: ["XAI_API_KEY"], label: "Grok" },
  kimi: {
    pluginId: "moonshot",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    label: "Kimi",
    credentialLabel: "Moonshot / Kimi API key",
  },
  perplexity: {
    pluginId: "perplexity",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    label: "Perplexity",
  },
  tavily: { pluginId: "tavily", envVars: ["TAVILY_API_KEY"], label: "Tavily" },
};

function getWebSearchConfig(config: OpenClawConfig | undefined, pluginId: string) {
  return (config as WebSearchConfigRecord | undefined)?.plugins?.entries?.[pluginId]?.config
    ?.webSearch;
}

function ensureWebSearchConfig(config: OpenClawConfig, pluginId: string) {
  const entries = ((config.plugins ??= {}).entries ??= {});
  const pluginEntry = (entries[pluginId] ??= {}) as {
    enabled?: boolean;
    config?: { webSearch?: Record<string, unknown> };
  };
  pluginEntry.config ??= {};
  pluginEntry.config.webSearch ??= {};
  return pluginEntry.config.webSearch;
}

function createSearchProviderEntry(id: string): PluginWebSearchProviderEntry {
  const metadata = SEARCH_PROVIDER_PLUGINS[id];
  if (!metadata) {
    throw new Error(`missing search provider fixture: ${id}`);
  }
  const entry: PluginWebSearchProviderEntry = {
    id: id as never,
    pluginId: metadata.pluginId,
    label: metadata.label,
    hint: `${metadata.label} web search`,
    onboardingScopes: ["text-inference"],
    envVars: metadata.envVars,
    placeholder: `${id}-key`,
    signupUrl: `https://example.com/${id}`,
    credentialLabel:
      metadata.credentialLabel ??
      (id === "gemini" ? "Google Gemini API key" : `${metadata.label} API key`),
    credentialPath: `plugins.entries.${metadata.pluginId}.config.webSearch.apiKey`,
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: (config) => getWebSearchConfig(config, metadata.pluginId)?.apiKey,
    setConfiguredCredentialValue: (config, value) => {
      ensureWebSearchConfig(config, metadata.pluginId).apiKey = value;
    },
    createTool: () => null,
    applySelectionConfig: (config) => {
      const next: OpenClawConfig = { ...config, plugins: { ...config.plugins } };
      const entries = { ...next.plugins?.entries } as NonNullable<
        NonNullable<OpenClawConfig["plugins"]>["entries"]
      >;
      entries[metadata.pluginId] = { ...entries[metadata.pluginId], enabled: true };
      next.plugins = { ...next.plugins, entries };
      return next;
    },
  };
  if (id === "kimi") {
    entry.runSetup = async ({ config, prompter }) => {
      const baseUrl = await prompter.select({
        message: "Moonshot endpoint",
        options: [{ value: "https://api.moonshot.ai/v1", label: "Moonshot" }],
        initialValue: "https://api.moonshot.ai/v1",
      });
      const modelChoice = await prompter.select({
        message: "Moonshot web-search model",
        options: [{ value: "__keep__", label: "Keep default" }],
        initialValue: "__keep__",
      });
      const webSearch = ensureWebSearchConfig(config, metadata.pluginId);
      webSearch.baseUrl = baseUrl;
      webSearch.model = modelChoice === "__keep__" ? "kimi-k2.5" : modelChoice;
      return config;
    };
  }
  return entry;
}

const searchProviderFixture = vi.hoisted(() => ({
  resolvePluginWebSearchProviders: vi.fn(() =>
    ["brave", "firecrawl", "gemini", "grok", "kimi", "perplexity", "tavily"].map((id) =>
      createSearchProviderEntry(id),
    ),
  ),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: searchProviderFixture.resolvePluginWebSearchProviders,
}));

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code: number) => {
    throw new Error(`unexpected exit ${code}`);
  }) as RuntimeEnv["exit"],
};

const SEARCH_PROVIDER_ENV_VARS = [
  "BRAVE_API_KEY",
  "FIRECRAWL_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "TAVILY_API_KEY",
  "XAI_API_KEY",
] as const;

let originalSearchProviderEnv: Partial<Record<(typeof SEARCH_PROVIDER_ENV_VARS)[number], string>> =
  {};

function createPrompter(params: {
  selectValue?: string;
  selectValues?: string[];
  textValue?: string;
}): {
  prompter: WizardPrompter;
  notes: Array<{ title?: string; message: string }>;
} {
  const notes: Array<{ title?: string; message: string }> = [];
  const remainingSelectValues = [...(params.selectValues ?? [])];
  const prompter: WizardPrompter = {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ title, message });
    }),
    select: vi.fn(
      async () => remainingSelectValues.shift() ?? params.selectValue ?? "perplexity",
    ) as unknown as WizardPrompter["select"],
    multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
    text: vi.fn(async () => params.textValue ?? ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
  return { prompter, notes };
}

function createPerplexityConfig(apiKey: string, enabled?: boolean): OpenClawConfig {
  return {
    tools: {
      web: {
        search: {
          provider: "perplexity",
          ...(enabled === undefined ? {} : { enabled }),
        },
      },
    },
    plugins: {
      entries: {
        perplexity: {
          config: {
            webSearch: {
              apiKey,
            },
          },
        },
      },
    },
  };
}

function pluginWebSearchApiKey(config: OpenClawConfig, pluginId: string): unknown {
  const entry = (
    config.plugins?.entries as
      | Record<string, { config?: { webSearch?: { apiKey?: unknown } } }>
      | undefined
  )?.[pluginId];
  return entry?.config?.webSearch?.apiKey;
}

function createDisabledFirecrawlConfig(apiKey?: string): OpenClawConfig {
  return {
    tools: {
      web: {
        search: {
          provider: "firecrawl",
        },
      },
    },
    plugins: {
      entries: {
        firecrawl: {
          enabled: false,
          ...(apiKey
            ? {
                config: {
                  webSearch: {
                    apiKey,
                  },
                },
              }
            : {}),
        },
      },
    },
  };
}

function readFirecrawlPluginApiKey(config: OpenClawConfig): string | undefined {
  const pluginConfig = config.plugins?.entries?.firecrawl?.config as
    | {
        webSearch?: {
          apiKey?: string;
        };
      }
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

async function runBlankPerplexityKeyEntry(
  apiKey: string,
  enabled?: boolean,
): Promise<OpenClawConfig> {
  const cfg = createPerplexityConfig(apiKey, enabled);
  const { prompter } = createPrompter({
    selectValue: "perplexity",
    textValue: "",
  });
  return setupSearch(cfg, runtime, prompter);
}

async function runQuickstartPerplexitySetup(
  apiKey: string,
  enabled?: boolean,
): Promise<{ result: OpenClawConfig; prompter: WizardPrompter }> {
  const cfg = createPerplexityConfig(apiKey, enabled);
  const { prompter } = createPrompter({ selectValue: "perplexity" });
  const result = await setupSearch(cfg, runtime, prompter, {
    quickstartDefaults: true,
  });
  return { result, prompter };
}

describe("setupSearch", () => {
  beforeEach(() => {
    originalSearchProviderEnv = Object.fromEntries(
      SEARCH_PROVIDER_ENV_VARS.map((key) => [key, process.env[key]]),
    );
    for (const key of SEARCH_PROVIDER_ENV_VARS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SEARCH_PROVIDER_ENV_VARS) {
      const value = originalSearchProviderEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns config unchanged when user skips", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "__skip__" });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result).toBe(cfg);
  });

  it("sets provider and key for perplexity", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "perplexity",
      textValue: "pplx-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("pplx-test-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.plugins?.entries?.perplexity?.enabled).toBe(true);
  });

  it("sets provider and key for brave", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "brave",
      textValue: "BSA-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "brave")).toBe("BSA-test-key");
    expect(result.plugins?.entries?.brave?.enabled).toBe(true);
  });

  it("sets provider and key for gemini", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "gemini",
      textValue: "AIza-test",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("gemini");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "google")).toBe("AIza-test");
    expect(result.plugins?.entries?.google?.enabled).toBe(true);
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Google Gemini API key",
      }),
    );
  });

  it("sets provider and key for firecrawl and enables the plugin", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "firecrawl",
      textValue: "fc-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "firecrawl")).toBe("fc-test-key");
    expect(result.plugins?.entries?.firecrawl?.enabled).toBe(true);
  });

  it("re-enables firecrawl and persists its plugin config when selected from disabled state", async () => {
    const cfg = createDisabledFirecrawlConfig();
    const { prompter } = createPrompter({
      selectValue: "firecrawl",
      textValue: "fc-disabled-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(readFirecrawlPluginApiKey(result)).toBe("fc-disabled-key");
  });

  it("sets provider and key for grok", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "grok",
      textValue: "xai-test",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("grok");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "xai")).toBe("xai-test");
    expect(result.plugins?.entries?.xai?.enabled).toBe(true);
  });

  it("sets provider and key for kimi", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValues: ["kimi", "https://api.moonshot.ai/v1", "__keep__"],
      textValue: "sk-moonshot",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    const kimiWebSearchConfig = result.plugins?.entries?.moonshot?.config?.webSearch as
      | {
          baseUrl?: string;
          model?: string;
        }
      | undefined;
    expect(result.tools?.web?.search?.provider).toBe("kimi");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "moonshot")).toBe("sk-moonshot");
    expect(result.plugins?.entries?.moonshot?.enabled).toBe(true);
    expect(kimiWebSearchConfig?.baseUrl).toBe("https://api.moonshot.ai/v1");
    expect(kimiWebSearchConfig?.model).toBe("kimi-k2.5");
  });

  it("sets provider and key for tavily and enables the plugin", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "tavily",
      textValue: "tvly-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("tavily");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "tavily")).toBe("tvly-test-key");
    expect(result.plugins?.entries?.tavily?.enabled).toBe(true);
  });

  it("shows missing-key note when no key is provided and no env var", async () => {
    const original = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      const cfg: OpenClawConfig = {};
      const { prompter, notes } = createPrompter({
        selectValue: "brave",
        textValue: "",
      });
      const result = await setupSearch(cfg, runtime, prompter);
      expect(result.tools?.web?.search?.provider).toBe("brave");
      expect(result.tools?.web?.search?.enabled).toBeUndefined();
      const missingNote = notes.find((n) => n.message.includes("No Brave Search API key stored"));
      expect(missingNote).toBeDefined();
    } finally {
      if (original === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = original;
      }
    }
  });

  it("keeps existing key when user leaves input blank", async () => {
    const result = await runBlankPerplexityKeyEntry(
      "existing-key", // pragma: allowlist secret
    );
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
  });

  it("advanced preserves enabled:false when keeping existing key", async () => {
    const result = await runBlankPerplexityKeyEntry(
      "existing-key", // pragma: allowlist secret
      false,
    );
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
  });

  it("quickstart skips key prompt when config key exists", async () => {
    const { result, prompter } = await runQuickstartPerplexitySetup(
      "stored-pplx-key", // pragma: allowlist secret
    );
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart preserves enabled:false when search was intentionally disabled", async () => {
    const { result, prompter } = await runQuickstartPerplexitySetup(
      "stored-pplx-key", // pragma: allowlist secret
      false,
    );
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart skips key prompt when canonical plugin config key exists", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "tavily",
          },
        },
      },
      plugins: {
        entries: {
          tavily: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "tvly-existing-key",
              },
            },
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "tavily" });
    const result = await setupSearch(cfg, runtime, prompter, {
      quickstartDefaults: true,
    });
    expect(result.tools?.web?.search?.provider).toBe("tavily");
    expect(pluginWebSearchApiKey(result, "tavily")).toBe("tvly-existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart falls through to key prompt when no key and no env var", async () => {
    const original = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      const cfg: OpenClawConfig = {};
      const { prompter } = createPrompter({ selectValue: "grok", textValue: "" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(prompter.text).toHaveBeenCalled();
      expect(result.tools?.web?.search?.provider).toBe("grok");
      expect(result.tools?.web?.search?.enabled).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = original;
      }
    }
  });

  it("uses provider-specific credential copy for kimi in onboarding", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "kimi",
      textValue: "",
    });
    await setupSearch(cfg, runtime, prompter);
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Moonshot / Kimi API key",
      }),
    );
  });

  it("quickstart skips key prompt when env var is available", async () => {
    const orig = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = "env-brave-key"; // pragma: allowlist secret
    try {
      const cfg: OpenClawConfig = {};
      const { prompter } = createPrompter({ selectValue: "brave" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(result.tools?.web?.search?.provider).toBe("brave");
      expect(result.tools?.web?.search?.enabled).toBe(true);
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (orig === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = orig;
      }
    }
  });

  it("quickstart detects an existing firecrawl key even when the plugin is disabled", async () => {
    const cfg = createDisabledFirecrawlConfig("fc-configured-key");
    const { prompter } = createPrompter({ selectValue: "firecrawl" });
    const result = await setupSearch(cfg, runtime, prompter, {
      quickstartDefaults: true,
    });
    expect(prompter.text).not.toHaveBeenCalled();
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(readFirecrawlPluginApiKey(result)).toBe("fc-configured-key");
  });

  it("preserves disabled firecrawl plugin state and allowlist when web search stays disabled", async () => {
    const original = process.env.FIRECRAWL_API_KEY;
    process.env.FIRECRAWL_API_KEY = "env-firecrawl-key"; // pragma: allowlist secret
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "firecrawl",
            enabled: false,
          },
        },
      },
      plugins: {
        allow: ["google"],
        entries: {
          firecrawl: {
            enabled: false,
          },
        },
      },
    };
    try {
      const { prompter } = createPrompter({ selectValue: "firecrawl" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(prompter.text).not.toHaveBeenCalled();
      expect(result.tools?.web?.search?.provider).toBe("firecrawl");
      expect(result.tools?.web?.search?.enabled).toBe(false);
      expect(result.plugins?.entries?.firecrawl?.enabled).toBe(false);
      expect(result.plugins?.allow).toEqual(["google"]);
    } finally {
      if (original === undefined) {
        delete process.env.FIRECRAWL_API_KEY;
      } else {
        process.env.FIRECRAWL_API_KEY = original;
      }
    }
  });

  it("stores env-backed SecretRef when secretInputMode=ref for perplexity", async () => {
    const originalPerplexity = process.env.PERPLEXITY_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const cfg: OpenClawConfig = {};
    try {
      const { prompter } = createPrompter({ selectValue: "perplexity" });
      const result = await setupSearch(cfg, runtime, prompter, {
        secretInputMode: "ref", // pragma: allowlist secret
      });
      expect(result.tools?.web?.search?.provider).toBe("perplexity");
      expect(pluginWebSearchApiKey(result, "perplexity")).toEqual({
        source: "env",
        provider: "default",
        id: "PERPLEXITY_API_KEY", // pragma: allowlist secret
      });
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (originalPerplexity === undefined) {
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = originalPerplexity;
      }
      if (originalOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      }
    }
  });

  it("prefers detected OPENROUTER_API_KEY SecretRef for perplexity ref mode", async () => {
    const originalPerplexity = process.env.PERPLEXITY_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const cfg: OpenClawConfig = {};
    try {
      const { prompter } = createPrompter({ selectValue: "perplexity" });
      const result = await setupSearch(cfg, runtime, prompter, {
        secretInputMode: "ref", // pragma: allowlist secret
      });
      expect(pluginWebSearchApiKey(result, "perplexity")).toEqual({
        source: "env",
        provider: "default",
        id: "OPENROUTER_API_KEY", // pragma: allowlist secret
      });
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (originalPerplexity === undefined) {
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = originalPerplexity;
      }
      if (originalOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      }
    }
  });

  it("stores env-backed SecretRef when secretInputMode=ref for brave", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "brave" });
    const result = await setupSearch(cfg, runtime, prompter, {
      secretInputMode: "ref", // pragma: allowlist secret
    });
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(pluginWebSearchApiKey(result, "brave")).toEqual({
      source: "env",
      provider: "default",
      id: "BRAVE_API_KEY",
    });
    expect(result.plugins?.entries?.brave?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("stores env-backed SecretRef when secretInputMode=ref for tavily", async () => {
    const original = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    const cfg: OpenClawConfig = {};
    try {
      const { prompter } = createPrompter({ selectValue: "tavily" });
      const result = await setupSearch(cfg, runtime, prompter, {
        secretInputMode: "ref", // pragma: allowlist secret
      });
      expect(result.tools?.web?.search?.provider).toBe("tavily");
      expect(pluginWebSearchApiKey(result, "tavily")).toEqual({
        source: "env",
        provider: "default",
        id: "TAVILY_API_KEY",
      });
      expect(result.plugins?.entries?.tavily?.enabled).toBe(true);
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = original;
      }
    }
  });

  it("stores plaintext key when secretInputMode is unset", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "brave",
      textValue: "BSA-plain",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(pluginWebSearchApiKey(result, "brave")).toBe("BSA-plain");
  });

  it("exports search providers in alphabetical order", () => {
    const providers = listSearchProviderOptions();
    const values = providers.map((e) => e.id);
    expect(values).toEqual([...values].toSorted());
    expect(values).toEqual(
      expect.arrayContaining([
        "brave",
        "firecrawl",
        "gemini",
        "grok",
        "kimi",
        "perplexity",
        "tavily",
      ]),
    );
  });
});
