import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => {
  const writeConfigFile = vi.fn();
  return {
    clackIntro: vi.fn(),
    clackOutro: vi.fn(),
    clackSelect: vi.fn(),
    clackText: vi.fn(),
    clackConfirm: vi.fn(),
    resolveSearchProviderOptions: vi.fn(),
    resolvePluginContributionOwners: vi.fn(),
    setupSearch: vi.fn(),
    readConfigFileSnapshot: vi.fn(),
    writeConfigFile,
    replaceConfigFile: vi.fn(async (params: { nextConfig: unknown }) => {
      await writeConfigFile(params.nextConfig);
    }),
    resolveGatewayPort: vi.fn(),
    ensureControlUiAssetsBuilt: vi.fn(),
    createClackPrompter: vi.fn(),
    note: vi.fn(),
    printWizardHeader: vi.fn(),
    probeGatewayReachable: vi.fn(),
    waitForGatewayReachable: vi.fn(),
    resolveControlUiLinks: vi.fn(),
    summarizeExistingConfig: vi.fn(),
    promptRemoteGatewayConfig: vi.fn(async (cfg: OpenClawConfig) => ({
      ...cfg,
      gateway: { mode: "remote", remote: { url: "wss://gateway.example.test" } },
    })),
    isCodexNativeWebSearchRelevant: vi.fn(({ config }: { config: OpenClawConfig }) =>
      Boolean(config.auth?.profiles?.["openai-codex:default"]),
    ),
    setupChannels: vi.fn(async (cfg: OpenClawConfig) => cfg),
  };
});

vi.mock("@clack/prompts", () => ({
  intro: mocks.clackIntro,
  outro: mocks.clackOutro,
  select: mocks.clackSelect,
  text: mocks.clackText,
  confirm: mocks.clackConfirm,
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "~/.openclaw/openclaw.json",
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  writeConfigFile: mocks.writeConfigFile,
  replaceConfigFile: mocks.replaceConfigFile,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt: mocks.ensureControlUiAssetsBuilt,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
  ensureWorkspaceAndSessions: vi.fn(),
  guardCancel: <T>(value: T) => value,
  printWizardHeader: mocks.printWizardHeader,
  probeGatewayReachable: mocks.probeGatewayReachable,
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  summarizeExistingConfig: mocks.summarizeExistingConfig,
  waitForGatewayReachable: mocks.waitForGatewayReachable,
}));

vi.mock("./health.js", () => ({
  healthCommand: vi.fn(),
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(),
}));

vi.mock("./configure.gateway.js", () => ({
  promptGatewayConfig: vi.fn(),
}));

vi.mock("./configure.gateway-auth.js", () => ({
  promptAuthConfig: vi.fn(),
}));

vi.mock("./configure.channels.js", () => ({
  removeChannelConfigWizard: vi.fn(),
}));

vi.mock("./configure.daemon.js", () => ({
  maybeInstallDaemon: vi.fn(),
}));

vi.mock("./onboard-remote.js", () => ({
  promptRemoteGatewayConfig: mocks.promptRemoteGatewayConfig,
}));

vi.mock("./onboard-skills.js", () => ({
  setupSkills: vi.fn(),
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: mocks.setupChannels,
}));

vi.mock("./onboard-search.js", () => ({
  resolveSearchProviderOptions: mocks.resolveSearchProviderOptions,
  setupSearch: mocks.setupSearch,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  resolvePluginContributionOwners: mocks.resolvePluginContributionOwners,
}));

vi.mock("../agents/codex-native-web-search.js", () => ({
  isCodexNativeWebSearchRelevant: mocks.isCodexNativeWebSearchRelevant,
}));

vi.mock("../config/mutate.js", async () => {
  const actual = await vi.importActual<typeof import("../config/mutate.js")>("../config/mutate.js");
  return {
    ...actual,
    ConfigMutationConflictError: actual.ConfigMutationConflictError,
  };
});

import { ConfigMutationConflictError } from "../config/mutate.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { runConfigureWizard } from "./configure.wizard.js";

const EMPTY_CONFIG_SNAPSHOT = {
  exists: false,
  valid: true,
  config: {},
  issues: [],
};

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createSearchProviderOption(overrides: Record<string, unknown>) {
  return overrides;
}

function createEnabledWebSearchConfig(provider: string, pluginEntry: Record<string, unknown>) {
  return (cfg: OpenClawConfig) => ({
    ...cfg,
    tools: {
      ...cfg.tools,
      web: {
        ...cfg.tools?.web,
        search: {
          provider,
          enabled: true,
        },
      },
    },
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [provider]: pluginEntry,
      },
    },
  });
}

function setupBaseWizardState(config: OpenClawConfig = {}) {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    ...EMPTY_CONFIG_SNAPSHOT,
    config,
  });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
  mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
  mocks.summarizeExistingConfig.mockReturnValue("");
  mocks.createClackPrompter.mockReturnValue({
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => "firecrawl"),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

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

function getGateway(config: Record<string, unknown>) {
  return requireRecord(config.gateway, "gateway config");
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

function queueWizardPrompts(params: { select: string[]; confirm: boolean[]; text?: string }) {
  const selectQueue = [...params.select];
  const confirmQueue = [...params.confirm];
  mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
  mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
  mocks.clackText.mockResolvedValue(params.text ?? "");
  mocks.clackIntro.mockResolvedValue(undefined);
  mocks.clackOutro.mockResolvedValue(undefined);
}

async function runWebConfigureWizard() {
  await runConfigureWizard({ command: "configure", sections: ["web"] }, createRuntime());
}

describe("runConfigureWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.resolvePluginContributionOwners.mockReturnValue(["firecrawl"]);
    mocks.resolveSearchProviderOptions.mockReturnValue([
      {
        id: "firecrawl",
        label: "Firecrawl Search",
        hint: "Structured results with optional result scraping",
        credentialLabel: "Firecrawl API key",
        envVars: ["FIRECRAWL_API_KEY"],
        placeholder: "fc-...",
        signupUrl: "https://www.firecrawl.dev/",
        credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
      },
    ]);
    mocks.setupSearch.mockReset();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => cfg);
  });

  it("persists gateway.mode=local when only the run mode is selected", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      select: ["local", "__continue"],
      confirm: [false],
    });

    await runConfigureWizard({ command: "configure" }, createRuntime());

    expect(getGateway(requireWriteConfig()).mode).toBe("local");
  });
  it("keeps startup gateway hint probes bounded", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        remote: {
          url: "wss://gateway.example.test",
          token: "token",
        },
      },
    });
    queueWizardPrompts({
      select: ["local", "__continue"],
      confirm: [],
    });

    await runConfigureWizard({ command: "configure" }, createRuntime());

    const probeRequests = mocks.probeGatewayReachable.mock.calls.map(([request]) =>
      requireRecord(request, "probe request"),
    );
    const localProbe = probeRequests.find((request) => request.url === "ws://127.0.0.1:18789");
    const remoteProbe = probeRequests.find(
      (request) => request.url === "wss://gateway.example.test",
    );
    expect(localProbe?.timeoutMs).toBe(300);
    expect(remoteProbe?.token).toBe("token");
    expect(remoteProbe?.timeoutMs).toBe(300);
  });

  it("exits with code 1 when configure wizard is cancelled", async () => {
    const runtime = createRuntime();
    setupBaseWizardState();
    mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());

    await runConfigureWizard({ command: "configure" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("persists provider-owned web search config changes returned by setupSearch", async () => {
    setupBaseWizardState();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) =>
      createEnabledWebSearchConfig("firecrawl", {
        enabled: true,
        config: { webSearch: { apiKey: "fc-entered-key" } },
      })(cfg),
    );
    queueWizardPrompts({
      select: ["local"],
      confirm: [true, false],
    });

    await runWebConfigureWizard();

    const setupConfig = requireRecord(
      mockCallArg(mocks.setupSearch, "setupSearch"),
      "setupSearch config",
    );
    expect(getGateway(setupConfig).mode).toBe("local");
    const written = requireWriteConfig();
    const search = getWebSearch(written);
    expect(search.provider).toBe("firecrawl");
    expect(search.enabled).toBe(true);
    const firecrawl = getPluginEntry(written, "firecrawl");
    expect(firecrawl.enabled).toBe(true);
    const firecrawlConfig = requireRecord(firecrawl.config, "firecrawl config");
    expect(requireRecord(firecrawlConfig.webSearch, "firecrawl web search").apiKey).toBe(
      "fc-entered-key",
    );
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });

  it("notes unavailable web search providers under plugin policy", async () => {
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([]);
    queueWizardPrompts({
      select: ["local"],
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
      select: ["local"],
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
      select: ["local", "configure"],
      confirm: [],
    });

    await runConfigureWizard({ command: "configure", sections: ["channels"] }, createRuntime());

    const setupChannelsCall = mocks.setupChannels.mock.calls[0] as Array<unknown> | undefined;
    const setupChannelsConfig = requireRecord(setupChannelsCall?.[0], "setupChannels config");
    expect(getGateway(setupChannelsConfig).mode).toBe("local");
    const setupChannelsOptions = requireRecord(setupChannelsCall?.[3], "setupChannels options");
    expect(setupChannelsOptions.deferStatusUntilSelection).toBe(true);
    expect(setupChannelsOptions.skipStatusNote).toBe(true);
  });

  it("still supports keyless web search providers through the shared setup flow", async () => {
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([
      createSearchProviderOption({
        id: "duckduckgo",
        label: "DuckDuckGo Search (experimental)",
        hint: "Free fallback",
        requiresCredential: false,
        envVars: [],
        placeholder: "(no key needed)",
        signupUrl: "https://duckduckgo.com/",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        credentialPath: "",
      }),
    ]);
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) =>
      createEnabledWebSearchConfig("duckduckgo", {
        enabled: true,
      })(cfg),
    );
    queueWizardPrompts({
      select: ["local"],
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
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
          },
        },
      },
    });
    queueWizardPrompts({
      select: ["local", "cached"],
      confirm: [true, true, false, true],
    });

    await runWebConfigureWizard();

    const search = getWebSearch(requireWriteConfig());
    expect(search.enabled).toBe(true);
    const codexSearch = requireRecord(search.openaiCodex, "Codex native search");
    expect(codexSearch.enabled).toBe(true);
    expect(codexSearch.mode).toBe("cached");
    expect(mocks.setupSearch).not.toHaveBeenCalled();
  });

  it("preserves disabled native Codex search when toggled off", async () => {
    setupBaseWizardState({
      auth: {
        profiles: {
          "openai-codex:default": {
            provider: "openai-codex",
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
      select: ["local"],
      confirm: [],
    });

    // Simulate plugin mutation: first replaceConfigFile call throws conflict,
    // second call after hash refresh succeeds
    let callCount = 0;
    const originalHash = "hash-before-plugin-mutation";
    const newHashAfterMutation = "hash-after-plugin-mutation";
    const finalHashAfterWrite = "hash-after-wizard-write";

    mocks.replaceConfigFile.mockImplementation(
      async (params: { nextConfig: unknown; baseHash?: string }) => {
        callCount++;
        if (callCount === 1) {
          // First call: simulate plugin mutating config during promptAuthConfig
          expect(params.baseHash).toBe(originalHash);
          throw new ConfigMutationConflictError("config changed since last load", {
            currentHash: newHashAfterMutation,
          });
        }
        // Second call: succeeds with refreshed hash
        expect(params.baseHash).toBe(newHashAfterMutation);
        await mocks.writeConfigFile(params.nextConfig);
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
      })
      .mockResolvedValueOnce({
        ...EMPTY_CONFIG_SNAPSHOT,
        hash: finalHashAfterWrite,
        config: {},
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
});
