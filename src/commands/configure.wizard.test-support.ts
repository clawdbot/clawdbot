import { vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

const wizardTestMocks = vi.hoisted(() => {
  const writeConfigFile = vi.fn();
  return {
    clackIntro: vi.fn(),
    clackOutro: vi.fn(),
    clackSelect: vi.fn(),
    clackText: vi.fn(),
    clackConfirm: vi.fn(),
    clackPassword: vi.fn(),
    resolveSearchProviderOptions: vi.fn(),
    resolvePluginContributionOwners: vi.fn(),
    setupSearch: vi.fn(),
    assertConfigPathForWrite: vi.fn(),
    readConfigFileSnapshot: vi.fn(),
    writeConfigFile,
    replaceConfigFile: vi.fn(
      async (params: {
        nextConfig: unknown;
        writeOptions?: { assertConfigPathForWrite?: () => void };
      }) => {
        params.writeOptions?.assertConfigPathForWrite?.();
        await writeConfigFile(params.nextConfig);
      },
    ),
    resolveGatewayPort: vi.fn(),
    createClackPrompter: vi.fn(),
    note: vi.fn(),
    printWizardHeader: vi.fn(),
    probeGatewayReachable: vi.fn(),
    waitForGatewayReachable: vi.fn(async () => ({ ok: true })),
    resolveAdvertisedControlUiLinks: vi.fn(),
    resolveControlUiLinks: vi.fn(),
    resolveLocalControlUiProbeLinks: vi.fn(),
    inspectWindowsGatewayFirewall: vi.fn(),
    summarizeExistingConfig: vi.fn(),
    healthCommand: vi.fn(),
    formatHealthCheckFailure: vi.fn<typeof import("./health-format.js").formatHealthCheckFailure>(),
    maybeInstallDaemon: vi.fn<typeof import("./configure.daemon.js").maybeInstallDaemon>(),
    promptAuthConfig: vi.fn(),
    promptGatewayConfig: vi.fn(),
    promptRemoteGatewayConfig: vi.fn(async (cfg: OpenClawConfig): Promise<OpenClawConfig> => ({
      ...cfg,
      gateway: { mode: "remote", remote: { url: "wss://gateway.example.test" } },
    })),
    isCodexNativeWebSearchRelevant: vi.fn(({ config }: { config: OpenClawConfig }) =>
      Boolean(config.auth?.profiles?.["openai:default"]),
    ),
    setupChannels: vi.fn(async (cfg: OpenClawConfig) => cfg),
    guardCancel: vi.fn((value: unknown, _runtime: RuntimeEnv, _exitCode?: number) => value),
  };
});

vi.mock("@clack/prompts", () => ({
  intro: wizardTestMocks.clackIntro,
  outro: wizardTestMocks.clackOutro,
  select: wizardTestMocks.clackSelect,
  text: wizardTestMocks.clackText,
  confirm: wizardTestMocks.clackConfirm,
  password: wizardTestMocks.clackPassword,
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "~/.openclaw/openclaw.json",
  createConfigIO: () => ({
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: await wizardTestMocks.readConfigFileSnapshot(),
      writeOptions: {
        assertConfigPathForWrite: wizardTestMocks.assertConfigPathForWrite,
        expectedConfigPath: "/tmp/openclaw.json",
        ownedConfigPathForWrite: "/tmp/openclaw.json",
      },
    }),
  }),
  readConfigFileSnapshot: wizardTestMocks.readConfigFileSnapshot,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: await wizardTestMocks.readConfigFileSnapshot(),
    writeOptions: {
      assertConfigPathForWrite: wizardTestMocks.assertConfigPathForWrite,
      envSnapshotForRestore: { SECRET: "resolved-secret" },
      expectedConfigPath: "/tmp/openclaw.json",
      includeFileHashesForWrite: { "/tmp/plugins.json5": "stale-hash" },
      ownedConfigPathForWrite: "/tmp/openclaw.json",
    },
  }),
  resolveConfigWriteAfterWrite: (afterWrite?: { mode: string }) => afterWrite ?? { mode: "auto" },
  transformConfigFileWithRetry: async (
    params: Parameters<typeof import("../config/config.js").transformConfigFileWithRetry>[0],
  ) => {
    const maxAttempts = params.maxAttempts ?? 5;
    for (let attempt = 0; ; attempt += 1) {
      const snapshot = await wizardTestMocks.readConfigFileSnapshot();
      const previousHash = snapshot.hash ?? null;
      const config =
        params.base === "runtime"
          ? (snapshot.runtimeConfig ?? snapshot.config)
          : (snapshot.sourceConfig ?? snapshot.config);
      try {
        const transformed = await params.transform(config, { snapshot, previousHash, attempt }, {});
        const committed = await params.commit!({
          nextConfig: transformed.nextConfig,
          snapshot,
          ...(previousHash ? { baseHash: previousHash } : {}),
          writeOptions: params.writeOptions,
          afterWrite: { mode: "auto" },
        });
        return { nextConfig: committed.config };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConfigMutationConflictError" ||
          (error as { retryable?: boolean }).retryable === false ||
          attempt === maxAttempts - 1
        ) {
          throw error;
        }
      }
    }
  },
  writeConfigFile: wizardTestMocks.writeConfigFile,
  replaceConfigFile: wizardTestMocks.replaceConfigFile,
  resolveGatewayPort: wizardTestMocks.resolveGatewayPort,
}));

vi.mock("../infra/windows-gateway-firewall-diagnostics.js", () => ({
  inspectWindowsGatewayFirewall: wizardTestMocks.inspectWindowsGatewayFirewall,
  formatWindowsGatewayFirewallGuidance: (params: { bind?: string }) =>
    params.bind === "lan"
      ? [
          "Windows firewall: if another device cannot connect to the LAN URL, run `openclaw gateway status --deep` from this Windows host.",
        ]
      : [],
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardTestMocks.createClackPrompter,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: wizardTestMocks.note,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
  ensureWorkspaceAndSessions: vi.fn(),
  guardCancel: wizardTestMocks.guardCancel,
  printWizardHeader: wizardTestMocks.printWizardHeader,
  probeGatewayReachable: wizardTestMocks.probeGatewayReachable,
  resolveAdvertisedControlUiLinks: wizardTestMocks.resolveAdvertisedControlUiLinks,
  resolveControlUiLinks: wizardTestMocks.resolveControlUiLinks,
  resolveLocalControlUiProbeLinks: wizardTestMocks.resolveLocalControlUiProbeLinks,
  summarizeExistingConfig: wizardTestMocks.summarizeExistingConfig,
  waitForGatewayReachable: wizardTestMocks.waitForGatewayReachable,
}));

vi.mock("./health.js", () => ({
  healthCommandNonExiting: wizardTestMocks.healthCommand,
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: wizardTestMocks.formatHealthCheckFailure,
}));

vi.mock("./configure.gateway.js", () => ({
  promptGatewayConfig: wizardTestMocks.promptGatewayConfig,
}));

vi.mock("./configure.gateway-auth.js", () => ({
  promptAuthConfig: wizardTestMocks.promptAuthConfig,
}));

vi.mock("./configure.channels.js", () => ({
  removeChannelConfigWizard: vi.fn(),
}));

vi.mock("./configure.daemon.js", () => ({
  maybeInstallDaemon: wizardTestMocks.maybeInstallDaemon,
}));

vi.mock("./onboard-remote.js", () => ({
  promptRemoteGatewayConfig: wizardTestMocks.promptRemoteGatewayConfig,
}));

vi.mock("./onboard-skills.js", () => ({
  setupSkills: vi.fn(),
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: wizardTestMocks.setupChannels,
}));

vi.mock("../flows/search-setup.js", () => ({
  resolveSearchProviderOptions: wizardTestMocks.resolveSearchProviderOptions,
  runSearchSetupFlow: wizardTestMocks.setupSearch,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  resolvePluginContributionOwners: wizardTestMocks.resolvePluginContributionOwners,
}));

vi.mock("../agents/codex-native-web-search.js", () => ({
  isCodexNativeWebSearchRelevant: wizardTestMocks.isCodexNativeWebSearchRelevant,
}));

// Load the wizard through this fixture so mocks register before its dependencies.
const { runConfigureWizard } = await import("./configure.wizard.js");
export { runConfigureWizard, wizardTestMocks };

export function setupWizardTestDefaults() {
  wizardTestMocks.assertConfigPathForWrite.mockImplementation(() => {});
  wizardTestMocks.resolvePluginContributionOwners.mockReturnValue(["firecrawl"]);
  wizardTestMocks.resolveSearchProviderOptions.mockReturnValue([
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
  wizardTestMocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => ({
    outcome: "completed",
    config: cfg,
  }));
  wizardTestMocks.promptAuthConfig.mockImplementation(async (cfg: OpenClawConfig) => cfg);
  wizardTestMocks.promptGatewayConfig.mockImplementation(async (cfg: OpenClawConfig) => ({
    config: cfg,
    port: 18789,
  }));
  wizardTestMocks.guardCancel.mockImplementation((value: unknown) => value);
}

export const EMPTY_CONFIG_SNAPSHOT = {
  exists: false,
  valid: true,
  config: {},
  issues: [],
};

export function createWizardTestRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

export function setupBaseWizardTestState(config: OpenClawConfig = {}) {
  wizardTestMocks.readConfigFileSnapshot.mockResolvedValue({ ...EMPTY_CONFIG_SNAPSHOT, config });
  wizardTestMocks.resolveGatewayPort.mockReturnValue(18789);
  wizardTestMocks.probeGatewayReachable.mockResolvedValue({ ok: false });
  wizardTestMocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
  wizardTestMocks.resolveLocalControlUiProbeLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  wizardTestMocks.resolveAdvertisedControlUiLinks.mockResolvedValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  wizardTestMocks.inspectWindowsGatewayFirewall.mockResolvedValue({
    applies: false,
    severity: "info",
    code: "windows_firewall_not_applicable",
    message: "Windows LAN firewall diagnostics do not apply.",
    details: [],
  });
  wizardTestMocks.summarizeExistingConfig.mockReturnValue("");
  wizardTestMocks.createClackPrompter.mockReturnValue({
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

export function queueWizardTestPrompts(params: {
  select: string[];
  confirm: boolean[];
  text?: string;
}) {
  const selectQueue = [...params.select];
  const confirmQueue = [...params.confirm];
  wizardTestMocks.clackSelect.mockImplementation(async () => selectQueue.shift());
  wizardTestMocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
  wizardTestMocks.clackText.mockResolvedValue(params.text ?? "");
  wizardTestMocks.clackIntro.mockResolvedValue(undefined);
  wizardTestMocks.clackOutro.mockResolvedValue(undefined);
}

export function createEnabledWebSearchConfig(
  provider: string,
  pluginEntry: Record<string, unknown>,
) {
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
