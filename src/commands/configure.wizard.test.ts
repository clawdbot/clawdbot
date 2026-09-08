// Configure wizard tests cover guided setup routing across gateway, auth, channels, skills, and search.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ConfigMutationConflictError } from "../config/mutate.js";
import { committedConfigFiles } from "./committed-config.test-support.js";
import {
  createEnabledWebSearchConfig,
  createWizardTestRuntime as createRuntime,
  EMPTY_CONFIG_SNAPSHOT,
  queueWizardTestPrompts as queueWizardPrompts,
  runConfigureWizard,
  setupWizardTestDefaults,
  setupBaseWizardTestState as setupBaseWizardState,
  wizardTestMocks as mocks,
} from "./configure.wizard.test-support.js";

const requireRecord = createRequireRecord("object", "expected-label");

function mockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  label: string,
  callIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex}`);
  }
  return call[0];
}

function requireWriteConfig(callIndex = 0) {
  return requireRecord(
    mockCallArg(mocks.writeConfigFile, "writeConfigFile", callIndex),
    "written config",
  );
}

function getWebSearch(config: Record<string, unknown>) {
  const tools = requireRecord(config.tools, "tools config");
  const web = requireRecord(tools.web, "web config");
  return requireRecord(web.search, "web search config");
}

function getPluginEntry(config: Record<string, unknown>, pluginId: string) {
  const plugins = requireRecord(config.plugins, "plugins config");
  const entries = requireRecord(plugins.entries, "plugin entries");
  return requireRecord(entries[pluginId], `${pluginId} entry`);
}

async function runWebConfigureWizard() {
  await runConfigureWizard({ command: "configure", sections: ["web"] }, createRuntime());
}

describe("runConfigureWizard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupWizardTestDefaults();
  });

  it.each(["gateway", "daemon", "health", "web"] as const)(
    "configures %s without requiring an agent owner",
    async (section) => {
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
        gateway: { mode: "local" },
      };
      setupBaseWizardState(config);
      queueWizardPrompts({ select: section === "web" ? [] : ["local"], confirm: [false, false] });

      await runConfigureWizard({ command: "configure", sections: [section] }, createRuntime());

      expect(mocks.promptAuthConfig).not.toHaveBeenCalled();
      expect(mocks.clackSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: "Which agent do you want to configure?" }),
      );
      if (section === "gateway") {
        expect(mocks.promptGatewayConfig).toHaveBeenCalledOnce();
      } else if (section === "daemon") {
        expect(mocks.maybeInstallDaemon).toHaveBeenCalledOnce();
      } else if (section === "health") {
        expect(mocks.healthCommand).toHaveBeenCalledOnce();
      } else {
        expect(getWebSearch(requireWriteConfig()).enabled).toBe(false);
      }
    },
  );

  it("persists provider-owned web search config changes returned by setupSearch", async () => {
    setupBaseWizardState();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => {
      const configured = createEnabledWebSearchConfig("firecrawl", {
        enabled: true,
        config: { webSearch: { apiKey: "fc-entered-key" } },
      })(cfg);
      return {
        outcome: "completed",
        config: {
          ...configured,
          tools: {
            ...configured.tools,
            web: {
              ...configured.tools?.web,
              fetch: { provider: "firecrawl" },
            },
          },
        },
      };
    });
    queueWizardPrompts({
      select: [],
      confirm: [true, true],
    });

    await runWebConfigureWizard();

    const setupConfig = requireRecord(
      mockCallArg(mocks.setupSearch, "setupSearch"),
      "setupSearch config",
    );
    expect(setupConfig.gateway).toBeUndefined();
    const written = requireWriteConfig();
    const search = getWebSearch(written);
    expect(search.provider).toBe("firecrawl");
    expect(search.enabled).toBe(true);
    const tools = requireRecord(written.tools, "tools config");
    const web = requireRecord(tools.web, "web config");
    expect(requireRecord(web.fetch, "web fetch config")).toEqual({
      enabled: true,
      provider: "firecrawl",
    });
    const firecrawl = getPluginEntry(written, "firecrawl");
    expect(firecrawl.enabled).toBe(true);
    const firecrawlConfig = requireRecord(firecrawl.config, "firecrawl config");
    expect(requireRecord(firecrawlConfig.webSearch, "firecrawl web search").apiKey).toBe(
      "fc-entered-key",
    );
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
    expect(mocks.setupSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { preserveDisabledSearchState: false },
    );
  });

  it("keeps web_search disabled when provider setup has no credential", async () => {
    setupBaseWizardState();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => ({
      outcome: "completed",
      config: {
        ...cfg,
        tools: {
          ...cfg.tools,
          web: {
            ...cfg.tools?.web,
            fetch: { provider: "firecrawl" },
            search: { enabled: false, provider: "firecrawl" },
          },
        },
      },
    }));
    queueWizardPrompts({
      select: [],
      confirm: [true, true],
    });

    await runWebConfigureWizard();

    const written = requireWriteConfig();
    expect(getWebSearch(written)).toMatchObject({
      enabled: false,
      provider: "firecrawl",
    });
    const tools = requireRecord(written.tools, "tools config");
    const web = requireRecord(tools.web, "web config");
    expect(requireRecord(web.fetch, "web fetch config")).toEqual({
      enabled: true,
      provider: "firecrawl",
    });
  });

  it("notes unavailable web search providers under plugin policy", async () => {
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([]);
    queueWizardPrompts({
      select: [],
      confirm: [true, false],
    });

    await expect(runWebConfigureWizard()).resolves.toBeUndefined();

    expect(mocks.note).toHaveBeenCalledWith(
      [
        "No web search providers are currently available under this plugin policy.",
        "Enable plugins or remove deny rules, then rerun configure.",
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "Web search",
    );
    expect(getWebSearch(requireWriteConfig()).enabled).toBe(false);
  });

  it("does not load managed search provider options when web search is disabled", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      select: [],
      confirm: [false, true],
    });

    await runWebConfigureWizard();

    const ownersRequest = requireRecord(
      mockCallArg(mocks.resolvePluginContributionOwners, "plugin owner request"),
      "plugin owner request",
    );
    expect(ownersRequest.contribution).toBe("contracts");
    expect(ownersRequest.matches).toBe("webSearchProviders");
    expect(mocks.resolveSearchProviderOptions).not.toHaveBeenCalled();
    expect(mocks.setupSearch).not.toHaveBeenCalled();
  });

  it("defers channel status checks until a channel is selected", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      select: ["configure"],
      confirm: [],
    });

    await runConfigureWizard({ command: "configure", sections: ["channels"] }, createRuntime());

    const setupChannelsCall = mocks.setupChannels.mock.calls[0] as Array<unknown> | undefined;
    const setupChannelsConfig = requireRecord(setupChannelsCall?.[0], "setupChannels config");
    expect(setupChannelsConfig.gateway).toBeUndefined();
    const setupChannelsOptions = requireRecord(setupChannelsCall?.[3], "setupChannels options");
    expect(setupChannelsOptions.deferStatusUntilSelection).toBe(true);
    expect(setupChannelsOptions.skipStatusNote).toBe(true);
  });

  it("still supports keyless web search providers through the shared setup flow", async () => {
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([
      {
        id: "duckduckgo",
        label: "DuckDuckGo Search (experimental)",
        hint: "Free fallback",
        requiresCredential: false,
        envVars: [],
        placeholder: "(no key needed)",
        signupUrl: "https://duckduckgo.com/",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        credentialPath: "",
      },
    ]);
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => ({
      outcome: "completed",
      config: createEnabledWebSearchConfig("duckduckgo", {
        enabled: true,
      })(cfg),
    }));
    queueWizardPrompts({
      select: [],
      confirm: [true, false],
    });

    await runWebConfigureWizard();

    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });

  it("can enable native Codex search without configuring a managed provider", async () => {
    setupBaseWizardState({
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "oauth",
          },
        },
      },
    });
    queueWizardPrompts({
      select: ["cached"],
      confirm: [true, true, false, true],
    });

    await runWebConfigureWizard();

    const search = getWebSearch(requireWriteConfig());
    expect(search.enabled).toBe(true);
    const codexSearch = requireRecord(search.openaiCodex, "Codex native search");
    expect(codexSearch.enabled).toBe(true);
    expect(codexSearch.mode).toBe("cached");
    expect(mocks.setupSearch).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      [
        "Web search lets your agent look things up online using the `web_search` tool.",
        "Codex-capable models can use native Codex web search.",
        "Other models use a separate web search provider, which you can configure here.",
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "Web search",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      [
        "Codex-capable models can use native Codex web search instead of a separate provider.",
        "Other models need a separate web search provider.",
        "If you do not choose one, OpenClaw can select a provider from available credentials; otherwise other models may not have web search.",
      ].join("\n"),
      "Codex native search",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      [
        "`web_fetch` is a separate tool for reading a specific URL.",
        "It does not require an API key and works independently of web search providers, including Codex.",
      ].join("\n"),
      "Web fetch",
    );
    expect(mocks.clackConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enable the web_search tool?" }),
    );
    expect(mocks.clackConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enable native Codex web search for Codex-capable models?",
      }),
    );
    expect(mocks.clackSelect).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Native Codex web search mode" }),
    );
    expect(mocks.clackConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Also configure a separate web search provider for other models?",
      }),
    );
    expect(mocks.clackConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enable the web_fetch tool?" }),
    );
  });

  it("preserves disabled native Codex search when toggled off", async () => {
    setupBaseWizardState({
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "oauth",
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            openaiCodex: {
              enabled: true,
              mode: "live",
            },
          },
        },
      },
    });
    queueWizardPrompts({
      select: ["firecrawl"],
      confirm: [true, false, true, false],
    });

    await runWebConfigureWizard();

    const search = getWebSearch(requireWriteConfig());
    expect(search.enabled).toBe(true);
    const codexSearch = requireRecord(search.openaiCodex, "Codex native search");
    expect(codexSearch.enabled).toBe(false);
    expect(codexSearch.mode).toBe("live");
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });

  it("retries without dropping nested plugin config written during wizard flow (issue #64188)", async () => {
    const baseConfig: OpenClawConfig = {
      plugins: {
        entries: {
          "github-copilot": {
            enabled: false,
            config: {
              region: "us-east-1",
            },
          },
        },
      },
    };
    setupBaseWizardState(baseConfig);
    queueWizardPrompts({
      select: [],
      confirm: [],
    });

    // Simulate plugin mutation: first replaceConfigFile call throws conflict,
    // second call after hash refresh succeeds
    let callCount = 0;
    const originalHash = "hash-before-plugin-mutation";
    const newHashAfterMutation = "hash-after-plugin-mutation";

    mocks.replaceConfigFile.mockImplementation(
      async (params: { nextConfig: unknown; baseHash?: string }) => {
        callCount++;
        if (callCount === 1) {
          // First call: simulate plugin mutating config during promptAuthConfig
          expect(params.baseHash).toBe(originalHash);
          throw new ConfigMutationConflictError("config changed since last load");
        }
        // Second call: succeeds with refreshed hash
        expect(params.baseHash).toBe(newHashAfterMutation);
        await mocks.writeConfigFile(params.nextConfig);
        return committedConfigFiles.write(params.nextConfig as OpenClawConfig);
      },
    );

    // Mock readConfigFileSnapshot to return different hashes/configs on each call
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce({
        ...EMPTY_CONFIG_SNAPSHOT,
        hash: originalHash,
        config: baseConfig,
        sourceConfig: baseConfig,
      })
      .mockResolvedValueOnce({
        ...EMPTY_CONFIG_SNAPSHOT,
        hash: originalHash,
        config: baseConfig,
        sourceConfig: baseConfig,
      })
      .mockResolvedValueOnce({
        ...EMPTY_CONFIG_SNAPSHOT,
        hash: newHashAfterMutation,
        config: {
          plugins: {
            entries: {
              "github-copilot": {
                enabled: false,
                config: {
                  region: "us-east-1",
                  accessToken: "plugin-wrote-this",
                },
              },
            },
          },
        },
        sourceConfig: {
          plugins: {
            entries: {
              "github-copilot": {
                enabled: false,
                config: {
                  region: "us-east-1",
                  accessToken: "plugin-wrote-this",
                },
              },
            },
          },
        },
        valid: true,
      });

    await runConfigureWizard({ command: "configure", sections: ["workspace"] }, createRuntime());

    // Verify retry happened: first call threw, second call succeeded
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    // Verify readConfigFileSnapshot was called: initial read, after conflict, after successful write
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(3);

    // Verify plugin-written nested config survived the retry merge.
    const retryCall = mockCallArg(mocks.replaceConfigFile, "replaceConfigFile", 1) as {
      nextConfig: Record<string, unknown>;
    };
    const agents = requireRecord(retryCall.nextConfig.agents, "agents config");
    const defaults = requireRecord(agents.defaults, "agent defaults");
    expect(String(defaults.workspace)).toContain("/.openclaw/workspace");
    const githubCopilot = getPluginEntry(retryCall.nextConfig, "github-copilot");
    expect(githubCopilot.enabled).toBe(false);
    const pluginConfig = requireRecord(githubCopilot.config, "github-copilot config");
    expect(pluginConfig.region).toBe("us-east-1");
    expect(pluginConfig.accessToken).toBe("plugin-wrote-this");
  });

  it("does not retry after config path ownership changes", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      select: [],
      confirm: [],
    });
    mocks.assertConfigPathForWrite.mockImplementation(() => {
      throw new ConfigMutationConflictError("config path changed since last load", {
        retryable: false,
      });
    });
    mocks.replaceConfigFile.mockImplementation(
      async (params: {
        nextConfig: unknown;
        writeOptions?: { assertConfigPathForWrite?: () => void };
      }) => {
        params.writeOptions?.assertConfigPathForWrite?.();
        await mocks.writeConfigFile(params.nextConfig);
        return committedConfigFiles.write(params.nextConfig as OpenClawConfig);
      },
    );

    await expect(
      runConfigureWizard({ command: "configure", sections: ["workspace"] }, createRuntime()),
    ).rejects.toThrow("config path changed since last load");

    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });
});
