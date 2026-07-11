// Setup finalize tests cover writing final onboarding config and artifacts.
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type {
  DefaultModelAuthStatus,
  DefaultModelCatalogFacts,
} from "../commands/auth-choice.model-check.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";

const launchTuiCli = vi.hoisted(() => vi.fn(async () => {}));
const restoreTerminalState = vi.hoisted(() => vi.fn());
const probeGatewayReachable = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({ ok: true })),
);
const waitForGatewayReachable = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({ ok: true })),
);
const resolveAdvertisedControlUiLinks = vi.hoisted(() =>
  vi.fn(async () => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
);
const resolveLocalControlUiProbeLinks = vi.hoisted(() =>
  vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
);
const setupWizardShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const resolveDefaultModelAuthStatus = vi.hoisted(() =>
  vi.fn<() => DefaultModelAuthStatus>(() => ({
    provider: "anthropic",
    model: "claude-opus-4-8",
    status: "ready",
    hasAuth: true,
  })),
);
const resolveDefaultModelCatalogFacts = vi.hoisted(() =>
  vi.fn<() => DefaultModelCatalogFacts>(() => ({ found: true })),
);
const loadModelCatalog = vi.hoisted(() =>
  vi.fn<(_params?: unknown) => Promise<unknown[]>>(async () => []),
);
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async (_params?: { warn?: (message: string, title?: string) => void }) => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
    environmentValueSources: {},
  })),
);
const gatewayServiceInstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceRestart = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" } | { outcome: "scheduled" }>>(async () => ({
    outcome: "completed",
  })),
);
const gatewayServiceUninstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceIsLoaded = vi.hoisted(() => vi.fn(async () => false));
const resolveGatewayInstallToken = vi.hoisted(() =>
  vi.fn(async () => ({
    token: undefined,
    tokenRefConfigured: true,
    warnings: [],
  })),
);
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const readSystemdUserLingerStatus = vi.hoisted(() =>
  vi.fn(async () => ({ user: "test-user", linger: "yes" as const })),
);
const resolveSetupSecretInputString = vi.hoisted(() =>
  vi.fn<() => Promise<string | undefined>>(async () => undefined),
);
const resolveExistingKey = vi.hoisted(() =>
  vi.fn<(config: OpenClawConfig, provider: string) => string | undefined>(() => undefined),
);
const hasExistingKey = vi.hoisted(() =>
  vi.fn<(config: OpenClawConfig, provider: string) => boolean>(() => false),
);
const hasKeyInEnv = vi.hoisted(() =>
  vi.fn<(entry: Pick<PluginWebSearchProviderEntry, "envVars">) => boolean>(() => false),
);
const listConfiguredWebSearchProviders = vi.hoisted(() =>
  vi.fn<(params?: { config?: OpenClawConfig }) => PluginWebSearchProviderEntry[]>(() => []),
);
const hasAuthProfileForProvider = vi.hoisted(() =>
  vi.fn<
    (params: {
      provider: string;
      agentDir?: string;
      includeExternalCli?: boolean;
      type?: string;
    }) => boolean
  >(() => false),
);
const isContainerEnvironment = vi.hoisted(() => vi.fn(() => false));
const startGatewayServer = vi.hoisted(() =>
  vi.fn(async () => ({
    close: vi.fn(async () => {}),
  })),
);
const inspectWindowsGatewayFirewall = vi.hoisted(() =>
  vi.fn<() => Promise<unknown>>(async () => ({
    applies: false,
    severity: "info",
    code: "windows_firewall_not_applicable",
    message: "Windows LAN firewall diagnostics do not apply.",
    details: [],
  })),
);

vi.mock("../commands/onboard-helpers.js", () => ({
  detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
  openUrl: vi.fn(async () => false),
  probeGatewayReachable,
  resolveAdvertisedControlUiLinks,
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  resolveLocalControlUiProbeLinks,
  waitForGatewayReachable,
}));

vi.mock("../infra/windows-gateway-firewall-diagnostics.js", () => ({
  inspectWindowsGatewayFirewall,
  formatWindowsGatewayFirewallGuidance: (params: { bind?: string }) =>
    params.bind === "lan"
      ? [
          "Windows firewall: if another device cannot connect to the LAN URL, run `openclaw gateway status --deep` from this Windows host.",
        ]
      : [],
}));

vi.mock("../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("../commands/gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  GATEWAY_DAEMON_RUNTIME_OPTIONS: [{ value: "node", label: "Node" }],
}));

vi.mock("../commands/health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("../commands/health.js", () => ({
  healthCommand,
}));

vi.mock("../commands/onboard-search.js", () => ({
  listSearchProviderOptions: () => [],
  resolveSearchProviderOptions: () => [],
  hasExistingKey,
  hasKeyInEnv,
  resolveExistingKey,
}));

vi.mock("../agents/tools/model-config.helpers.js", () => ({
  hasAuthProfileForProvider,
}));

vi.mock("../web-search/runtime.js", () => ({
  listConfiguredWebSearchProviders,
}));

vi.mock("../daemon/service.js", () => ({
  describeGatewayServiceRestart: vi.fn((serviceNoun: string, result: { outcome: string }) =>
    result.outcome === "scheduled"
      ? {
          scheduled: true,
          daemonActionResult: "scheduled",
          message: `restart scheduled, ${serviceNoun.toLowerCase()} will restart momentarily`,
          progressMessage: `${serviceNoun} service restart scheduled.`,
        }
      : {
          scheduled: false,
          daemonActionResult: "restarted",
          message: `${serviceNoun} service restarted.`,
          progressMessage: `${serviceNoun} service restarted.`,
        },
  ),
  resolveGatewayService: vi.fn(() => ({
    isLoaded: gatewayServiceIsLoaded,
    restart: gatewayServiceRestart,
    uninstall: gatewayServiceUninstall,
    install: gatewayServiceInstall,
  })),
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
  readSystemdUserLingerStatus,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment,
}));

vi.mock("../gateway/server.js", () => ({
  startGatewayServer,
}));

vi.mock("../../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState,
}));

vi.mock("../tui/tui-launch.js", () => ({
  launchTuiCli,
}));

vi.mock("../commands/auth-choice.js", () => ({
  applyAuthChoice: vi.fn(),
  resolveDefaultModelCatalogFacts,
  resolveDefaultModelAuthStatus,
  resolvePreferredProviderForAuthChoice: vi.fn(),
  warnIfModelConfigLooksOff: vi.fn(),
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await loadModelCatalog(...args);
    return { entries, routeVariants: entries };
  },
}));

vi.mock("./setup.secret-input.js", () => ({
  resolveSetupSecretInputString,
}));

vi.mock("./setup.completion.js", () => ({
  setupWizardShellCompletion,
}));

import { finalizeSetupWizard } from "./setup.finalize.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createWebSearchProviderEntry(
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "id"
    | "label"
    | "hint"
    | "envVars"
    | "authProviderId"
    | "placeholder"
    | "signupUrl"
    | "credentialPath"
    | "requiresCredential"
  >,
): PluginWebSearchProviderEntry {
  return {
    pluginId: `plugin-${provider.id}`,
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    createTool: () => null,
    ...provider,
  };
}

function expectFirstOnboardingInstallPlanCallOmitsToken() {
  const [firstArg] =
    (buildGatewayInstallPlan.mock.calls[0] as unknown as [Record<string, unknown>] | undefined) ??
    [];
  if (!firstArg) {
    throw new Error("expected first onboarding install plan call");
  }
  expect("token" in firstArg).toBe(false);
}

type AdvancedFinalizeArgs = {
  nextConfig?: OpenClawConfig;
  prompter?: ReturnType<typeof buildWizardPrompter>;
  runtime?: RuntimeEnv;
  installDaemon?: boolean;
};

function createModelAuthFinalizeArgs(params: {
  prompter: ReturnType<typeof buildWizardPrompter>;
  nextConfig?: OpenClawConfig;
}) {
  return {
    flow: "quickstart" as const,
    opts: {
      acceptRisk: true,
      authChoice: "skip" as const,
      installDaemon: false,
      skipHealth: true,
      skipUi: false,
    },
    baseConfig: {},
    nextConfig: params.nextConfig ?? {},
    workspaceDir: "/tmp",
    settings: {
      port: 18789,
      bind: "loopback" as const,
      authMode: "token" as const,
      gatewayToken: undefined,
      tailscaleMode: "off" as const,
      tailscaleResetOnExit: false,
    },
    prompter: params.prompter,
    runtime: createRuntime(),
  };
}

function createLaterPrompter() {
  return buildWizardPrompter({
    select: vi.fn(async () => "later") as never,
    confirm: vi.fn(async () => false),
  });
}

function createEnabledFirecrawlSearchConfig(): OpenClawConfig {
  return {
    tools: {
      web: {
        search: {
          provider: "firecrawl",
          enabled: true,
        },
      },
    },
  };
}

function createAdvancedFinalizeArgs(params: AdvancedFinalizeArgs = {}) {
  return {
    flow: "advanced" as const,
    opts: {
      acceptRisk: true,
      authChoice: "skip" as const,
      installDaemon: params.installDaemon ?? false,
      skipHealth: true,
      skipUi: true,
    },
    baseConfig: {},
    nextConfig: params.nextConfig ?? {},
    workspaceDir: "/tmp",
    settings: {
      port: 18789,
      bind: "loopback" as const,
      authMode: "token" as const,
      gatewayToken: undefined,
      tailscaleMode: "off" as const,
      tailscaleResetOnExit: false,
    },
    prompter: params.prompter ?? createLaterPrompter(),
    runtime: params.runtime ?? createRuntime(),
  };
}

function requireMockArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function expectNoteContains(
  prompter: ReturnType<typeof buildWizardPrompter>,
  expected: string,
  title: string,
): void {
  const calls = vi.mocked(prompter.note).mock.calls;
  expect(calls.filter((call) => call[0].includes(expected) && call[1] === title)).not.toEqual([]);
}

function expectNoteTitleNotCalled(
  prompter: ReturnType<typeof buildWizardPrompter>,
  title: string,
): void {
  const calls = vi.mocked(prompter.note).mock.calls;
  expect(calls.filter((call) => call[1] === title)).toEqual([]);
}

function expectNoteNotContains(
  prompter: ReturnType<typeof buildWizardPrompter>,
  unexpected: string,
): void {
  const calls = vi.mocked(prompter.note).mock.calls;
  expect(calls.filter((call) => call[0].includes(unexpected))).toEqual([]);
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

describe("finalizeSetupWizard", () => {
  beforeEach(() => {
    launchTuiCli.mockClear();
    restoreTerminalState.mockClear();
    probeGatewayReachable.mockReset();
    probeGatewayReachable.mockResolvedValue({ ok: false, detail: "offline" });
    waitForGatewayReachable.mockReset();
    waitForGatewayReachable.mockResolvedValue({ ok: true });
    resolveAdvertisedControlUiLinks.mockReset();
    resolveAdvertisedControlUiLinks.mockResolvedValue({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    });
    resolveLocalControlUiProbeLinks.mockReset();
    resolveLocalControlUiProbeLinks.mockReturnValue({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    });
    setupWizardShellCompletion.mockClear();
    healthCommand.mockReset();
    healthCommand.mockResolvedValue(undefined);
    buildGatewayInstallPlan.mockClear();
    gatewayServiceInstall.mockClear();
    gatewayServiceIsLoaded.mockReset();
    gatewayServiceIsLoaded.mockResolvedValue(false);
    gatewayServiceRestart.mockReset();
    gatewayServiceRestart.mockResolvedValue({ outcome: "completed" });
    gatewayServiceUninstall.mockReset();
    resolveGatewayInstallToken.mockClear();
    isSystemdUserServiceAvailable.mockReset();
    isSystemdUserServiceAvailable.mockResolvedValue(true);
    readSystemdUserLingerStatus.mockReset();
    readSystemdUserLingerStatus.mockResolvedValue({ user: "test-user", linger: "yes" });
    resolveSetupSecretInputString.mockReset();
    resolveSetupSecretInputString.mockResolvedValue(undefined);
    resolveExistingKey.mockReset();
    resolveExistingKey.mockReturnValue(undefined);
    hasExistingKey.mockReset();
    hasExistingKey.mockReturnValue(false);
    hasKeyInEnv.mockReset();
    hasKeyInEnv.mockReturnValue(false);
    listConfiguredWebSearchProviders.mockReset();
    listConfiguredWebSearchProviders.mockReturnValue([]);
    hasAuthProfileForProvider.mockReset();
    hasAuthProfileForProvider.mockReturnValue(false);
    isContainerEnvironment.mockReset();
    isContainerEnvironment.mockReturnValue(false);
    startGatewayServer.mockReset();
    startGatewayServer.mockResolvedValue({ close: vi.fn(async () => {}) });
    inspectWindowsGatewayFirewall.mockReset();
    inspectWindowsGatewayFirewall.mockResolvedValue({
      applies: false,
      severity: "info",
      code: "windows_firewall_not_applicable",
      message: "Windows LAN firewall diagnostics do not apply.",
      details: [],
    });
    resolveDefaultModelAuthStatus.mockReset();
    resolveDefaultModelAuthStatus.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-8",
      status: "ready",
      hasAuth: true,
    });
    resolveDefaultModelCatalogFacts.mockReset();
    resolveDefaultModelCatalogFacts.mockReturnValue({ found: true });
    loadModelCatalog.mockReset();
    loadModelCatalog.mockResolvedValue([]);
  });

  it("resolves gateway password SecretRef for probe but omits auth from TUI hatch", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "resolved-gateway-password"; // pragma: allowlist secret
    resolveSetupSecretInputString.mockResolvedValueOnce("resolved-gateway-password");
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "How do you want to hatch your agent?") {
        return "tui";
      }
      return "later";
    });
    const prompter = buildWizardPrompter({
      select: select as never,
      confirm: vi.fn(async () => false),
    });
    const runtime = createRuntime();

    try {
      await finalizeSetupWizard({
        flow: "quickstart",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: false,
        },
        baseConfig: {},
        nextConfig: {
          gateway: {
            auth: {
              mode: "password",
              password: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_GATEWAY_PASSWORD",
              },
            },
          },
          tools: {
            web: {
              search: {
                apiKey: "",
              },
            },
          },
        },
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "password",
          gatewayToken: undefined,
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    const probeParams = requireMockArg(probeGatewayReachable) as {
      url?: string;
      password?: string;
    };
    expect(probeParams.url).toBe("ws://127.0.0.1:18789");
    expect(probeParams.password).toBe("resolved-gateway-password"); // pragma: allowlist secret
    expect(launchTuiCli).toHaveBeenCalledWith(
      {
        local: true,
        deliver: false,
        message: undefined,
        timeoutMs: 300_000,
      },
      {},
    );
  });

  it("advertises LAN Control UI links while probing the local gateway", async () => {
    resolveAdvertisedControlUiLinks.mockResolvedValueOnce({
      httpUrl: "http://10.211.55.3:18789/",
      wsUrl: "ws://10.211.55.3:18789",
    });
    resolveLocalControlUiProbeLinks.mockReturnValue({
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
    });
    const prompter = createLaterPrompter();
    const args = createAdvancedFinalizeArgs({
      nextConfig: {
        gateway: {
          bind: "lan",
        },
      },
      prompter,
    });

    await finalizeSetupWizard({
      ...args,
      opts: {
        ...args.opts,
        skipHealth: false,
        skipUi: false,
      },
      settings: {
        ...args.settings,
        bind: "lan",
      },
    });

    expect(resolveAdvertisedControlUiLinks).toHaveBeenCalledWith(
      expect.objectContaining({ bind: "lan", port: 18789 }),
    );
    expect(waitForGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expectNoteContains(prompter, "http://10.211.55.3:18789/", "Control UI");
    expectNoteContains(prompter, "ws://10.211.55.3:18789", "Control UI");
  });

  it("shows static Windows Firewall guidance for LAN Control UI links without inspection", async () => {
    const prompter = createLaterPrompter();
    const args = createAdvancedFinalizeArgs({
      nextConfig: {
        gateway: {
          bind: "lan",
        },
      },
      prompter,
    });

    await finalizeSetupWizard({
      ...args,
      opts: {
        ...args.opts,
        skipHealth: false,
        skipUi: false,
      },
      settings: {
        ...args.settings,
        bind: "lan",
      },
    });

    expect(inspectWindowsGatewayFirewall).not.toHaveBeenCalled();
    expectNoteContains(
      prompter,
      "Windows firewall: if another device cannot connect to the LAN URL",
      "Control UI",
    );
  });

  it("bounds the bootstrap hatch TUI run timeout", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "How do you want to hatch your agent?") {
        return "tui";
      }
      return "later";
    });
    const prompter = buildWizardPrompter({
      select: select as never,
      confirm: vi.fn(async () => false),
    });

    await finalizeSetupWizard({
      flow: "quickstart",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: true,
        skipUi: false,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(launchTuiCli).toHaveBeenCalledWith(
      {
        local: true,
        deliver: false,
        message: "Wake up, my friend!",
        timeoutMs: 300_000,
      },
      {},
    );
  });

  it("passes physical catalog routes into the bootstrap auth decision", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const catalog = [
      {
        id: "gpt-5.4-nano",
        name: "GPT 5.4 Nano",
        provider: "openai",
      },
    ];
    const observedRoutes = [
      {
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1" },
    ];
    loadModelCatalog.mockResolvedValueOnce(catalog);
    resolveDefaultModelCatalogFacts.mockReturnValueOnce({ found: true, observedRoutes });
    const prompter = buildWizardPrompter({
      confirm: vi.fn(async () => false),
    });
    const nextConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.4-nano" },
        list: [{ id: "main", agentDir: "/tmp/custom-agent" }],
      },
    } satisfies OpenClawConfig;

    await finalizeSetupWizard(createModelAuthFinalizeArgs({ prompter, nextConfig }));

    expect(loadModelCatalog).toHaveBeenCalledWith({ config: nextConfig, readOnly: true });
    expect(resolveDefaultModelCatalogFacts).toHaveBeenCalledWith(nextConfig, catalog, {
      routeVariants: catalog,
    });
    expect(resolveDefaultModelAuthStatus).toHaveBeenCalledWith(nextConfig, {
      agentDir: "/tmp/custom-agent",
      observedRoutes,
    });
  });

  it("skips the doomed hatch seed message and warns when model auth is missing", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    resolveDefaultModelAuthStatus.mockReturnValueOnce({
      provider: "openai",
      model: "gpt-5.5",
      status: "missing",
      hasAuth: false,
    });
    const prompter = buildWizardPrompter({
      confirm: vi.fn(async () => false),
    });

    await finalizeSetupWizard(
      createModelAuthFinalizeArgs({
        prompter,
        nextConfig: {
          agents: {
            list: [{ id: "main", agentDir: "/tmp/custom-agent" }],
          },
        },
      }),
    );

    expect(launchTuiCli).toHaveBeenCalledWith(expect.objectContaining({ message: undefined }), {});
    expect(resolveDefaultModelAuthStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: {
          list: [{ id: "main", agentDir: "/tmp/custom-agent" }],
        },
      }),
      { agentDir: "/tmp/custom-agent" },
    );
    expectNoteContains(
      prompter,
      'No credentials are configured for provider "openai"',
      "Model auth missing",
    );
  });

  it("hatches without a seed and omits setup advice for indeterminate model auth", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    resolveDefaultModelAuthStatus.mockReturnValueOnce({
      provider: "openai",
      model: "gpt-5.5",
      status: "indeterminate",
      hasAuth: false,
    });
    const prompter = buildWizardPrompter({
      confirm: vi.fn(async () => false),
    });

    await finalizeSetupWizard(createModelAuthFinalizeArgs({ prompter }));

    expect(launchTuiCli).toHaveBeenCalledWith(expect.objectContaining({ message: undefined }), {});
    expectNoteTitleNotCalled(prompter, "Model auth missing");
    expectNoteNotContains(prompter, "No credentials are configured");
    expectNoteNotContains(prompter, "openclaw configure --section model");
  });

  it("hatches without a seed and omits setup advice for an incompatible model route", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    resolveDefaultModelAuthStatus.mockReturnValueOnce({
      provider: "openai",
      model: "gpt-5.6",
      status: "incompatible",
      hasAuth: false,
      code: "auth_mode_unsupported",
      message: "gpt-5.6 requires OpenAI Platform API-key authentication.",
    });
    const prompter = buildWizardPrompter({
      confirm: vi.fn(async () => false),
    });

    await finalizeSetupWizard(createModelAuthFinalizeArgs({ prompter }));

    expect(launchTuiCli).toHaveBeenCalledWith(expect.objectContaining({ message: undefined }), {});
    expectNoteTitleNotCalled(prompter, "Model auth missing");
    expectNoteNotContains(prompter, "No credentials are configured");
    expectNoteNotContains(prompter, "openclaw configure --section model");
  });

  it("does not resend the bootstrap hatch message on setup reruns", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const prompter = buildWizardPrompter({
      confirm: vi.fn(async () => false),
    });

    await finalizeSetupWizard({
      flow: "quickstart",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: true,
        skipUi: false,
      },
      baseConfig: {},
      hadExistingConfig: true,
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(launchTuiCli).toHaveBeenCalledWith(
      {
        local: true,
        deliver: false,
        message: undefined,
        timeoutMs: 300_000,
      },
      {},
    );
  });

  it("localizes the bootstrap hatch TUI seed message", async () => {
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_LOCALE = "zh-CN";
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "你想如何启动 agent？") {
        return "tui";
      }
      return "later";
    });
    const prompter = buildWizardPrompter({
      select: select as never,
      confirm: vi.fn(async () => false),
    });

    try {
      await finalizeSetupWizard({
        flow: "quickstart",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: false,
        },
        baseConfig: {},
        nextConfig: {},
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "token",
          gatewayToken: undefined,
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime: createRuntime(),
      });

      expect(launchTuiCli).toHaveBeenCalledWith(
        {
          local: true,
          deliver: false,
          message: "醒醒，我的朋友！",
          timeoutMs: 300_000,
        },
        {},
      );
    } finally {
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }
  });

  it("prints completion before handing off to the TUI", async () => {
    const prompter = createLaterPrompter();

    await finalizeSetupWizard({
      flow: "quickstart",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: true,
        skipUi: false,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(prompter.outro).toHaveBeenCalledWith(
      "Onboarding complete. Use the dashboard link above to control OpenClaw.",
    );
    expect(launchTuiCli).toHaveBeenCalledOnce();
    expect(vi.mocked(prompter.outro).mock.invocationCallOrder[0]).toBeLessThan(
      launchTuiCli.mock.invocationCallOrder[0],
    );
  });

  it("restores terminal state after failed TUI hatch", async () => {
    launchTuiCli.mockRejectedValueOnce(new Error("TUI exited with code 1"));
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "How do you want to hatch your agent?") {
        return "tui";
      }
      return "later";
    });
    const prompter = buildWizardPrompter({ select: select as never });

    await expect(
      finalizeSetupWizard({
        flow: "advanced",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: false,
        },
        baseConfig: {},
        nextConfig: {},
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "token",
          gatewayToken: "test-token",
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime: createRuntime(),
      }),
    ).rejects.toThrow("TUI exited with code 1");

    expect(restoreTerminalState).toHaveBeenCalledWith("pre-setup tui", {
      resumeStdinIfPaused: false,
    });
    expect(restoreTerminalState).toHaveBeenCalledWith("post-setup tui", {
      resumeStdinIfPaused: false,
    });
  });

  it("does not persist resolved SecretRef token in daemon install plan", async () => {
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: vi.fn(async () => false),
    });
    const runtime = createRuntime();
    buildGatewayInstallPlan.mockResolvedValueOnce({
      programArguments: [],
      workingDirectory: "/tmp",
      environment: {
        DISCORD_BOT_TOKEN: "discord-test-token",
      },
      environmentValueSources: {
        DISCORD_BOT_TOKEN: "file",
      },
    });

    await finalizeSetupWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: true,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_TOKEN",
            },
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime,
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expectFirstOnboardingInstallPlanCallOmitsToken();
    expect(gatewayServiceInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentValueSources: {
          DISCORD_BOT_TOKEN: "file",
        },
      }),
    );
  });

  it("waits for gateway install warnings before installing the service", async () => {
    let acknowledgeWarning: (() => void) | undefined;
    const warningAcknowledged = new Promise<void>((resolve) => {
      acknowledgeWarning = resolve;
    });
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: vi.fn(async () => false),
      note: vi.fn(async (message: string) => {
        if (message === "Gateway install warning") {
          await warningAcknowledged;
        }
      }),
    });
    buildGatewayInstallPlan.mockImplementationOnce(async (params) => {
      params?.warn?.("Gateway install warning", "Gateway service");
      return {
        programArguments: [],
        workingDirectory: "/tmp",
        environment: {},
        environmentValueSources: {},
      };
    });

    const finalizePromise = finalizeSetupWizard(
      createAdvancedFinalizeArgs({ installDaemon: true, prompter }),
    );
    await vi.waitFor(() => {
      expect(prompter.note).toHaveBeenCalledWith("Gateway install warning", "Gateway service");
    });
    expect(gatewayServiceInstall).not.toHaveBeenCalled();

    acknowledgeWarning?.();
    await finalizePromise;

    expect(gatewayServiceInstall).toHaveBeenCalledTimes(1);
  });

  it("shows gateway install warnings when planning fails", async () => {
    const prompter = createLaterPrompter();
    buildGatewayInstallPlan.mockImplementationOnce(async (params) => {
      params?.warn?.("Gateway install warning", "Gateway service");
      throw new Error("plan failed");
    });

    await finalizeSetupWizard(createAdvancedFinalizeArgs({ installDaemon: true, prompter }));

    expect(prompter.note).toHaveBeenCalledWith("Gateway install warning", "Gateway service");
    expectNoteContains(prompter, "plan failed", "Gateway");
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
  });

  it("suppresses token-bearing onboarding output when requested", async () => {
    const prompter = createLaterPrompter();

    await finalizeSetupWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: true,
        skipUi: true,
        suppressGatewayTokenOutput: true,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    const output = vi
      .mocked(prompter.note)
      .mock.calls.map((call) => call.join("\n"))
      .join("\n");
    expect(output).toContain("http://127.0.0.1:18789");
    expect(output).not.toContain("session-token");
    expect(output).not.toContain("#token=");
  });

  it("stops after a scheduled restart instead of reinstalling the service", async () => {
    const progressUpdate = vi.fn();
    const progressStop = vi.fn();
    gatewayServiceIsLoaded.mockResolvedValue(true);
    gatewayServiceRestart.mockResolvedValueOnce({ outcome: "scheduled" });
    const prompter = buildWizardPrompter({
      select: vi.fn(async (params: { message: string }) => {
        if (params.message === "Gateway service already installed") {
          return "restart";
        }
        return "later";
      }) as never,
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: progressUpdate, stop: progressStop })),
    });

    await finalizeSetupWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: true,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(gatewayServiceRestart).toHaveBeenCalledTimes(1);
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
    expect(gatewayServiceUninstall).not.toHaveBeenCalled();
    expect(progressUpdate).toHaveBeenCalledWith("Restarting Gateway service...");
    expect(progressStop).toHaveBeenCalledWith("Gateway service restart scheduled.");
  });

  it("localizes finalize non-prompt notes", async () => {
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_LOCALE = "zh-CN";
    const prompter = createLaterPrompter();

    try {
      await finalizeSetupWizard(createAdvancedFinalizeArgs({ prompter }));
    } finally {
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }

    const noteMessages = (prompter.note as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[0]),
    );
    expect(noteMessages.some((message) => message.includes("备份你的 agent 工作区"))).toBe(true);
    expect(
      noteMessages.some((message) => message.includes("在你的电脑上运行 agent 存在风险")),
    ).toBe(true);
    expect(noteMessages.some((message) => message.includes("已跳过 web search"))).toBe(true);
  });

  it("reports selected providers blocked by plugin policy as unavailable", async () => {
    const prompter = createLaterPrompter();

    await finalizeSetupWizard(
      createAdvancedFinalizeArgs({
        nextConfig: createEnabledFirecrawlSearchConfig(),
        prompter,
      }),
    );

    expectNoteContains(
      prompter,
      "selected but unavailable under the current plugin policy",
      "Web search",
    );
    expect(resolveExistingKey).not.toHaveBeenCalled();
    expect(hasExistingKey).not.toHaveBeenCalled();
  });

  it("only reports legacy auto-detect for runtime-visible providers", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        id: "perplexity",
        label: "Perplexity Search",
        hint: "Fast web answers",
        envVars: ["PERPLEXITY_API_KEY"],
        placeholder: "pplx-...",
        signupUrl: "https://www.perplexity.ai/",
        credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
      }),
    ]);
    hasExistingKey.mockImplementation((configForTest, provider) => provider === "perplexity");

    const prompter = createLaterPrompter();

    await finalizeSetupWizard(createAdvancedFinalizeArgs({ prompter }));

    expectNoteContains(
      prompter,
      "Web search is available via Perplexity Search (auto-detected).",
      "Web search",
    );
  });

  it("uses configured provider resolution instead of the active runtime registry", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        id: "firecrawl",
        label: "Firecrawl Search",
        hint: "Structured results",
        envVars: ["FIRECRAWL_API_KEY"],
        placeholder: "fc-...",
        signupUrl: "https://www.firecrawl.dev/",
        credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
      }),
    ]);
    hasExistingKey.mockImplementation((configForTest, provider) => provider === "firecrawl");

    const prompter = createLaterPrompter();

    await finalizeSetupWizard(
      createAdvancedFinalizeArgs({
        nextConfig: createEnabledFirecrawlSearchConfig(),
        prompter,
      }),
    );

    expectNoteContains(
      prompter,
      "Web search is enabled, so your agent can look things up online when needed.",
      "Web search",
    );
  });

  it("reports OAuth-backed web search as enabled without an API key", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        id: "grok",
        label: "Grok (xAI)",
        hint: "Uses xAI OAuth or API key",
        envVars: ["XAI_API_KEY"],
        authProviderId: "xai",
        placeholder: "xai-...",
        signupUrl: "https://console.x.ai/",
        credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
      }),
    ]);
    hasAuthProfileForProvider.mockImplementation(
      ({ provider, type }) => provider === "xai" && (!type || type === "oauth"),
    );

    const prompter = createLaterPrompter();

    await finalizeSetupWizard(
      createAdvancedFinalizeArgs({
        nextConfig: {
          tools: {
            web: {
              search: {
                provider: "grok",
                enabled: true,
              },
            },
          },
        },
        prompter,
      }),
    );

    expectNoteContains(
      prompter,
      "Web search is enabled, so your agent can look things up online when needed.",
      "Web search",
    );
    expectNoteContains(prompter, "Credential: existing xAI OAuth sign-in.", "Web search");
    expect(
      vi
        .mocked(prompter.note)
        .mock.calls.some(
          ([message, title]) => title === "Web search" && message.includes("no API key"),
        ),
    ).toBe(false);
    expect(hasAuthProfileForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
      }),
    );
    expect(hasAuthProfileForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        type: "oauth",
      }),
    );
  });

  it("reports a keyless provider as ready without prompting for an API key", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        id: "parallel-free",
        label: "Parallel Search (Free)",
        hint: "Free web search via Parallel's hosted Search MCP",
        envVars: [],
        placeholder: "",
        signupUrl: "https://parallel.ai",
        credentialPath: "",
        requiresCredential: false,
      }),
    ]);

    const prompter = createLaterPrompter();

    await finalizeSetupWizard(
      createAdvancedFinalizeArgs({
        nextConfig: {
          tools: { web: { search: { provider: "parallel-free", enabled: true } } },
        },
        prompter,
      }),
    );

    expectNoteContains(
      prompter,
      "Web search is ready — this provider works with no API key.",
      "Web search",
    );
    // The credential-required warning must NOT appear for a keyless provider.
    expect(
      vi
        .mocked(prompter.note)
        .mock.calls.some(
          ([message, title]) =>
            title === "Web search" &&
            (message.includes("no API key was found") ||
              message.includes("will not work until a key is added")),
        ),
    ).toBe(false);
  });

  it("uses the setup token for health checks to avoid local env token drift", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");
    const prompter = createLaterPrompter();

    await finalizeSetupWizard({
      flow: "quickstart",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: false,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: "config-token",
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    const healthArgs = requireMockArg(healthCommand) as {
      json?: boolean;
      timeoutMs?: number;
      token?: string;
      config?: OpenClawConfig;
    };
    expect(healthArgs.json).toBe(false);
    expect(healthArgs.timeoutMs).toBe(10_000);
    expect(healthArgs.token).toBe("session-token");
    expect(healthArgs.config?.gateway?.auth?.mode).toBe("token");
    expect(healthArgs.config?.gateway?.auth?.token).toBe("session-token");
    expect(requireMockArg(healthCommand, 0, 1)).toBeTypeOf("object");
  });

  it("labels unavailable systemd as container runtime information in containers", async () => {
    await withPlatform("linux", async () => {
      isSystemdUserServiceAvailable.mockResolvedValue(false);
      isContainerEnvironment.mockReturnValue(true);
      const prompter = createLaterPrompter();

      await finalizeSetupWizard(createAdvancedFinalizeArgs({ prompter }));

      expectNoteContains(
        prompter,
        "Systemd user services are not available inside this container.",
        "Container runtime",
      );
      expectNoteTitleNotCalled(prompter, "Systemd");
      expect(gatewayServiceInstall).not.toHaveBeenCalled();
    });
  });

  it("starts a session gateway and launches gateway-backed TUI in containers without systemd", async () => {
    await withPlatform("linux", async () => {
      isSystemdUserServiceAvailable.mockResolvedValue(false);
      isContainerEnvironment.mockReturnValue(true);
      waitForGatewayReachable.mockResolvedValue({ ok: true });
      probeGatewayReachable.mockResolvedValue({ ok: true });
      const sessionGateway = { close: vi.fn(async () => {}) };
      startGatewayServer.mockResolvedValueOnce(sessionGateway);
      const prompter = createLaterPrompter();

      await finalizeSetupWizard({
        flow: "quickstart",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: undefined,
          skipHealth: false,
          skipUi: false,
        },
        baseConfig: {},
        nextConfig: {
          gateway: {
            auth: {
              mode: "token",
              token: "test-token",
            },
          },
        },
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "token",
          gatewayToken: "test-token",
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime: createRuntime(),
      });

      expect(startGatewayServer).toHaveBeenCalledWith(
        18789,
        expect.objectContaining({
          bind: "loopback",
          auth: expect.objectContaining({
            mode: "token",
            token: "test-token",
          }),
        }),
      );
      expect(launchTuiCli).toHaveBeenCalledWith(
        {
          deliver: false,
          message: undefined,
          timeoutMs: 300_000,
        },
        { gatewayUrl: "ws://127.0.0.1:18789", authSource: "config" },
      );
      expect(sessionGateway.close).toHaveBeenCalledWith({ reason: "onboarding tui exited" });
    });
  });

  it("closes a session gateway when finalize fails before TUI launch", async () => {
    await withPlatform("linux", async () => {
      isSystemdUserServiceAvailable.mockResolvedValue(false);
      isContainerEnvironment.mockReturnValue(true);
      waitForGatewayReachable.mockRejectedValueOnce(new Error("probe failed"));
      const sessionGateway = { close: vi.fn(async () => {}) };
      startGatewayServer.mockResolvedValueOnce(sessionGateway);
      const prompter = createLaterPrompter();

      await expect(
        finalizeSetupWizard({
          flow: "quickstart",
          opts: {
            acceptRisk: true,
            authChoice: "skip",
            installDaemon: undefined,
            skipHealth: false,
            skipUi: false,
          },
          baseConfig: {},
          nextConfig: {
            gateway: {
              auth: {
                mode: "token",
                token: "test-token",
              },
            },
          },
          workspaceDir: "/tmp",
          settings: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
            gatewayToken: "test-token",
            tailscaleMode: "off",
            tailscaleResetOnExit: false,
          },
          prompter,
          runtime: createRuntime(),
        }),
      ).rejects.toThrow("probe failed");

      expect(launchTuiCli).not.toHaveBeenCalled();
      expect(sessionGateway.close).toHaveBeenCalledWith({ reason: "onboarding finalize exited" });
    });
  });

  it("uses the resolved setup password for health checks", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "env-password");
    resolveSetupSecretInputString.mockResolvedValueOnce("session-password");
    const prompter = createLaterPrompter();

    await finalizeSetupWizard({
      flow: "quickstart",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: false,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        gateway: {
          auth: {
            mode: "password",
            password: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_PASSWORD",
            },
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "password",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    const waitArgs = requireMockArg(waitForGatewayReachable) as {
      url?: string;
      token?: string;
      password?: string;
    };
    expect(waitArgs.url).toBe("ws://127.0.0.1:18789");
    expect(waitArgs.token).toBeUndefined();
    expect(waitArgs.password).toBe("session-password");
    const healthArgs = requireMockArg(healthCommand) as {
      json?: boolean;
      timeoutMs?: number;
      token?: string;
      password?: string;
      config?: OpenClawConfig;
    };
    expect(healthArgs.json).toBe(false);
    expect(healthArgs.timeoutMs).toBe(10_000);
    expect(healthArgs.token).toBeUndefined();
    expect(healthArgs.password).toBe("session-password");
    expect(healthArgs.config?.gateway?.auth?.mode).toBe("password");
    expect(requireMockArg(healthCommand, 0, 1)).toBeTypeOf("object");
  });

  it("shows actionable gateway guidance instead of a hard error in no-daemon onboarding", async () => {
    waitForGatewayReachable.mockResolvedValue({
      ok: false,
      detail: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
    });
    probeGatewayReachable.mockResolvedValue({
      ok: false,
      detail: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
    });
    const prompter = createLaterPrompter();
    const runtime = createRuntime();

    await finalizeSetupWizard({
      flow: "quickstart",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: false,
        skipUi: false,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "test-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime,
    });

    expect(runtime.error).not.toHaveBeenCalledWith("health failed");
    expectNoteContains(prompter, "Setup was run without Gateway service install", "Gateway");
    expectNoteTitleNotCalled(prompter, "Dashboard ready");
  });

  it("does not show a Codex native search summary when web search is globally disabled", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = buildWizardPrompter({
      note,
      select: vi.fn(async () => "later") as never,
      confirm: vi.fn(async () => false),
    });

    await finalizeSetupWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        tools: {
          web: {
            search: {
              enabled: false,
              openaiCodex: {
                enabled: true,
                mode: "cached",
              },
            },
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(note.mock.calls.filter((call) => call[1] === "Codex native search")).toEqual([]);
  });
});
