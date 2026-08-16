// Setup finalize tests cover writing final onboarding config and artifacts.
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type * as AuthChoiceModelCheck from "../commands/auth-choice.model-check.js";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayTlsConfig } from "../config/types.gateway.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";

type DefaultModelAuthStatus = ReturnType<typeof AuthChoiceModelCheck.resolveDefaultModelAuthStatus>;
type DefaultModelCatalogFacts = ReturnType<
  typeof AuthChoiceModelCheck.resolveDefaultModelCatalogFacts
>;

const runTui = vi.hoisted(() => vi.fn<(options: unknown) => Promise<void>>(async () => {}));
const restoreTerminalState = vi.hoisted(() => vi.fn());
const probeGatewayReachable = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({ ok: true })),
);
const waitForGatewayReachable = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({ ok: true })),
);
const resolveControlUiHandoffTarget = vi.hoisted(() =>
  vi.fn(async (params: { config: OpenClawConfig }) => ({
    documentUrl: "http://127.0.0.1:18789/",
    tlsConfig: params.config.gateway?.tls,
  })),
);
const waitForControlUiDocument = vi.hoisted(() =>
  vi.fn(
    async (_params: {
      url: string;
      tlsConfig?: GatewayTlsConfig;
      onPending?: () => void;
    }): Promise<{ ready: true } | { ready: false; reason: string }> => ({ ready: true }),
  ),
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
const startGatewayService = vi.hoisted(() => vi.fn());
const resolveGatewayInstallToken = vi.hoisted(() =>
  vi.fn(async () => ({
    token: undefined,
    tokenRefConfigured: true,
    warnings: [],
  })),
);
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const resolveSystemdUserServiceAccount = vi.hoisted(() =>
  vi.fn(() => "test-user" as string | null),
);
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
  probeGatewayReachable,
  resolveAdvertisedControlUiLinks,
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  resolveLocalControlUiProbeLinks,
  waitForGatewayReachable,
}));

vi.mock("../commands/control-ui-handoff.js", () => ({
  resolveControlUiHandoffTarget,
  waitForControlUiDocument,
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

vi.mock("../flows/search-setup.js", () => ({
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
  formatGatewayServiceStartRepairIssues: (issues: Array<{ message: string }>) =>
    issues.map((issue) => issue.message).join("; "),
  startGatewayService,
  resolveGatewayService: vi.fn(() => ({
    label: "Mock Platform Service",
    isLoaded: gatewayServiceIsLoaded,
    restart: gatewayServiceRestart,
    uninstall: gatewayServiceUninstall,
    install: gatewayServiceInstall,
  })),
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
  resolveSystemdUserServiceAccount,
  readSystemdUserLingerStatus,
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

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

vi.mock("../commands/auth-choice.js", () => ({
  applyAuthChoice: vi.fn(),
  resolveDefaultModelCatalogFacts,
  resolveDefaultModelAuthStatus,
  resolvePreferredProviderForAuthChoice: vi.fn(),
  warnIfModelConfigLooksOff: vi.fn(),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
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

import { ensureGatewayServiceForOnboarding, finalizeSetupWizard } from "./setup.finalize.js";

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
    runTui.mockClear();
    restoreTerminalState.mockClear();
    probeGatewayReachable.mockReset();
    probeGatewayReachable.mockResolvedValue({ ok: false, detail: "offline" });
    waitForGatewayReachable.mockReset();
    waitForGatewayReachable.mockResolvedValue({ ok: true });
    resolveControlUiHandoffTarget.mockReset();
    resolveControlUiHandoffTarget.mockImplementation(async ({ config }) => ({
      documentUrl: "http://127.0.0.1:18789/",
      tlsConfig: config.gateway?.tls,
    }));
    waitForControlUiDocument.mockReset();
    waitForControlUiDocument.mockResolvedValue({ ready: true });
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
    startGatewayService.mockReset();
    gatewayServiceRestart.mockReset();
    gatewayServiceRestart.mockResolvedValue({ outcome: "completed" });
    gatewayServiceUninstall.mockReset();
    resolveGatewayInstallToken.mockClear();
    isSystemdUserServiceAvailable.mockReset();
    isSystemdUserServiceAvailable.mockResolvedValue(true);
    resolveSystemdUserServiceAccount.mockReset();
    resolveSystemdUserServiceAccount.mockReturnValue("test-user");
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
        },
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "password",
          gatewayToken: undefined,
          tailscaleMode: "off",
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
    expect(runTui).toHaveBeenCalledWith({
      local: true,
      deliver: false,
      forceProcessExitOnReturn: true,
      message: undefined,
      timeoutMs: 300_000,
    });
  });

  it("waits for the served dashboard before announcing its URL", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    const stop = vi.fn();
    const prompter = buildWizardPrompter({
      progress: vi.fn(() => ({ update: vi.fn(), stop })),
    });
    let resolveDocument: ((value: { ready: true }) => void) | undefined;
    waitForControlUiDocument.mockImplementation(async ({ onPending }) => {
      onPending?.();
      return await new Promise<{ ready: true }>((resolve) => {
        resolveDocument = resolve;
      });
    });

    const finalizing = finalizeSetupWizard(createModelAuthFinalizeArgs({ prompter }));
    await vi.waitFor(() => expect(waitForControlUiDocument).toHaveBeenCalledOnce());
    expectNoteTitleNotCalled(prompter, "Control UI");
    expect(prompter.outro).not.toHaveBeenCalled();
    expect(prompter.progress).toHaveBeenCalledWith("Preparing the Control UI…");

    resolveDocument?.({ ready: true });
    await finalizing;

    expect(stop).toHaveBeenCalledOnce();
    expectNoteContains(prompter, "Web UI: http://127.0.0.1:18789", "Control UI");
  });

  it("keeps the reachable Gateway and TUI when dashboard preparation fails", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    waitForControlUiDocument.mockResolvedValue({
      ready: false,
      reason: "Control UI build failed: missing startup.js",
    });
    const prompter = createLaterPrompter();
    const args = createModelAuthFinalizeArgs({ prompter });
    const gatewayToken = ["classic", "token"].join("-");

    await finalizeSetupWizard({
      ...args,
      settings: { ...args.settings, gatewayToken },
    });

    expect(args.runtime.error).toHaveBeenCalledWith("Control UI build failed: missing startup.js");
    expectNoteContains(prompter, "Gateway: reachable", "Control UI");
    expectNoteNotContains(prompter, "Web UI:");
    expectNoteNotContains(prompter, gatewayToken);
    expect(prompter.outro).toHaveBeenCalledWith(
      "OpenClaw is ready. When you're ready: openclaw dashboard",
    );
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        config: args.nextConfig,
        forceProcessExitOnReturn: true,
        boundGateway: {
          url: "ws://127.0.0.1:18789",
          token: gatewayToken,
        },
      }),
    );
    const tuiOptions = runTui.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(tuiOptions).not.toHaveProperty("url");
    expect(tuiOptions).not.toHaveProperty("token");
  });

  it.each([
    { name: "the UI was skipped", skipUi: true, enabled: true, reachable: true },
    { name: "the UI is disabled", skipUi: false, enabled: false, reachable: true },
    { name: "the Gateway is offline", skipUi: false, enabled: true, reachable: false },
    { name: "the skipped UI Gateway is offline", skipUi: true, enabled: true, reachable: false },
  ])("does not wait for dashboard assets when $name", async ({ skipUi, enabled, reachable }) => {
    probeGatewayReachable.mockResolvedValue({ ok: reachable, detail: "offline" });
    const prompter = createLaterPrompter();
    const args = createModelAuthFinalizeArgs({
      prompter,
      nextConfig: { gateway: { controlUi: { enabled } } },
    });
    const gatewayToken = ["offline", "token"].join("-");

    await finalizeSetupWizard({
      ...args,
      opts: { ...args.opts, skipUi },
      settings: { ...args.settings, gatewayToken },
    });

    expect(resolveControlUiHandoffTarget).not.toHaveBeenCalled();
    expect(waitForControlUiDocument).not.toHaveBeenCalled();
    if (!enabled || (!reachable && !skipUi)) {
      expectNoteNotContains(prompter, "Web UI:");
    }
    if (!reachable || skipUi) {
      expectNoteNotContains(prompter, gatewayToken);
    }
    if (!enabled) {
      expect(prompter.outro).toHaveBeenCalledWith("OpenClaw is ready.");
    }
  });

  it("probes the canonical loopback dashboard for custom TLS Gateway paths", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    const tlsConfig = { enabled: true, caPath: "/gateway/clients.pem" };
    resolveControlUiHandoffTarget.mockResolvedValueOnce({
      documentUrl: "https://127.0.0.1:19876/dashboard/",
      tlsConfig,
    });
    const nextConfig: OpenClawConfig = {
      gateway: {
        port: 18789,
        bind: "loopback",
        tls: tlsConfig,
      },
    };
    const args = createModelAuthFinalizeArgs({ prompter: createLaterPrompter(), nextConfig });

    await finalizeSetupWizard({
      ...args,
      baseConfig: { gateway: { controlUi: { basePath: "/dashboard" } } },
      settings: {
        ...args.settings,
        port: 19876,
        bind: "custom",
        customBindHost: "10.0.0.5",
      },
    });

    expect(resolveControlUiHandoffTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          gateway: expect.objectContaining({
            port: 19876,
            bind: "custom",
            customBindHost: "10.0.0.5",
            controlUi: { basePath: "/dashboard" },
            tls: tlsConfig,
          }),
        }),
        env: expect.objectContaining({ OPENCLAW_GATEWAY_PORT: "19876" }),
      }),
    );
    expect(waitForControlUiDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://127.0.0.1:19876/dashboard/",
        tlsConfig,
      }),
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
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      deliver: false,
      forceProcessExitOnReturn: true,
      message: "Wake up, my friend!",
      timeoutMs: 300_000,
    });
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

    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ message: undefined }));
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

    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ message: undefined }));
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

    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ message: undefined }));
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
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      deliver: false,
      forceProcessExitOnReturn: true,
      message: undefined,
      timeoutMs: 300_000,
    });
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
        },
        prompter,
        runtime: createRuntime(),
      });

      expect(runTui).toHaveBeenCalledWith({
        local: true,
        deliver: false,
        forceProcessExitOnReturn: true,
        message: "醒醒，我的朋友！",
        timeoutMs: 300_000,
      });
    } finally {
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }
  });

  it("prints completion before handing off to the TUI", async () => {
    probeGatewayReachable.mockResolvedValueOnce({ ok: true });
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
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(prompter.outro).toHaveBeenCalledWith(
      "Onboarding complete. Use the dashboard link above to control OpenClaw.",
    );
    expect(runTui).toHaveBeenCalledOnce();
    expect(vi.mocked(prompter.outro).mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        runTui.mock.invocationCallOrder[0],
        "runTui.mock.invocationCallOrder[0] test invariant",
      ),
    );
  });

  it("restores terminal state after failed TUI hatch", async () => {
    runTui.mockRejectedValueOnce(new Error("TUI exited with code 1"));
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

  it("reports gateway installation failure without waiting for impossible health", async () => {
    gatewayServiceInstall.mockRejectedValueOnce(new Error("service install exploded"));
    const prompter = createLaterPrompter();
    const runtime = createRuntime();
    const args = createAdvancedFinalizeArgs({ installDaemon: true, prompter, runtime });

    await finalizeSetupWizard({ ...args, opts: { ...args.opts, skipHealth: false } });

    expect(waitForGatewayReachable).not.toHaveBeenCalled();
    expect(probeGatewayReachable).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("health failed");
    expectNoteContains(prompter, "service install exploded", "Gateway");
    expectNoteContains(prompter, "Gateway: not detected (service install exploded)", "Control UI");
    expect(prompter.outro).toHaveBeenCalledWith(
      expect.stringContaining("managed Mock Platform Service setup failed"),
    );
    expectNoteContains(prompter, "openclaw gateway status --deep", "Gateway");
    expectNoteContains(prompter, "openclaw gateway install --force", "Gateway");
    expectNoteNotContains(prompter, "openclaw gateway run");
    expectNoteNotContains(prompter, "openclaw gateway restart");
  });

  it.each([
    ["readiness timeout", "gateway readiness timed out"],
    ["service crash", "gateway closed (1006 abnormal closure)"],
    ["occupied port", "listen EADDRINUSE: address already in use 127.0.0.1:18789"],
  ])("keeps managed %s recovery on the canonical service path", async (_name, detail) => {
    waitForGatewayReachable.mockResolvedValue({ ok: false, detail });
    probeGatewayReachable.mockResolvedValue({ ok: false, detail });
    const prompter = createLaterPrompter();
    const args = createAdvancedFinalizeArgs({ installDaemon: true, prompter });

    await finalizeSetupWizard({ ...args, opts: { ...args.opts, skipHealth: false } });

    expectNoteContains(prompter, "managed Mock Platform Service", "Gateway");
    expectNoteContains(prompter, "openclaw gateway status --deep", "Gateway");
    expectNoteContains(prompter, "openclaw gateway restart", "Gateway");
    expectNoteNotContains(prompter, "openclaw gateway run");
    expectNoteNotContains(prompter, "openclaw onboard --install-daemon");
    expectNoteNotContains(prompter, "openclaw gateway install --force");
  });

  it("localizes managed service recovery at the finalize boundary", async () => {
    await withEnvAsync({ OPENCLAW_LOCALE: "zh-CN" }, async () => {
      waitForGatewayReachable.mockResolvedValue({ ok: false, detail: "readiness timed out" });
      probeGatewayReachable.mockResolvedValue({ ok: false, detail: "readiness timed out" });
      const prompter = createLaterPrompter();
      const args = createAdvancedFinalizeArgs({ installDaemon: true, prompter });

      await finalizeSetupWizard({ ...args, opts: { ...args.opts, skipHealth: false } });

      expectNoteContains(prompter, "托管的 Mock Platform Service 在设置后仍无法访问", "Gateway");
      expectNoteContains(prompter, "检查服务状态和日志", "Gateway");
      expectNoteContains(prompter, "openclaw gateway restart", "Gateway");
      expectNoteNotContains(prompter, "openclaw gateway run");
    });
  });

  it("returns an authoritative failed outcome when gateway installation fails", async () => {
    gatewayServiceInstall.mockRejectedValueOnce(new Error("service install exploded"));
    const prompter = createLaterPrompter();

    const result = await ensureGatewayServiceForOnboarding({
      flow: "quickstart",
      opts: {},
      nextConfig: {},
      settings: { port: 18789 },
      prompter,
      runtime: createRuntime(),
    });

    expect(result.gateway).toEqual({ status: "failed", error: "service install exploded" });
    expectNoteContains(prompter, "service install exploded", "Gateway");
  });

  it("recognizes external supervision before probing Linux systemd", async () => {
    await withPlatform("linux", async () => {
      await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
        isSystemdUserServiceAvailable.mockResolvedValue(false);
        isContainerEnvironment.mockReturnValue(true);
        const prompter = createLaterPrompter();

        const result = await ensureGatewayServiceForOnboarding({
          flow: "quickstart",
          opts: {},
          nextConfig: {},
          settings: { port: 18789 },
          prompter,
          runtime: createRuntime(),
        });

        expect(result).toEqual({
          gateway: { status: "skipped", reason: "external" },
          containerWithoutUserSystemd: false,
        });
        expect(isSystemdUserServiceAvailable).not.toHaveBeenCalled();
        expect(isContainerEnvironment).not.toHaveBeenCalled();
        expectNoteContains(
          prompter,
          "OpenClaw gateway lifecycle is managed by an external supervisor",
          "Gateway",
        );
        expectNoteNotContains(prompter, "Systemd user services are not available");
        expect(gatewayServiceInstall).not.toHaveBeenCalled();
      });
    });
  });

  it("preserves external supervision through unreachable container recovery", async () => {
    await withPlatform("linux", async () => {
      await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
        isSystemdUserServiceAvailable.mockResolvedValue(false);
        isContainerEnvironment.mockReturnValue(true);
        waitForGatewayReachable.mockResolvedValue({
          ok: false,
          detail: "external gateway is offline",
        });
        probeGatewayReachable.mockResolvedValue({
          ok: false,
          detail: "external gateway is offline",
        });
        const prompter = createLaterPrompter();
        const args = createAdvancedFinalizeArgs({ prompter });

        await finalizeSetupWizard({
          ...args,
          opts: { ...args.opts, skipHealth: false, skipUi: false },
        });

        expect(isSystemdUserServiceAvailable).not.toHaveBeenCalled();
        expect(isContainerEnvironment).not.toHaveBeenCalled();
        expect(startGatewayServer).not.toHaveBeenCalled();
        expectNoteContains(prompter, "Use that supervisor to start the gateway.", "Gateway");
        expectNoteNotContains(prompter, "openclaw gateway run");
        expectNoteNotContains(prompter, "openclaw onboard --install-daemon");
        expect(prompter.outro).toHaveBeenCalledWith(
          "Gateway not detected yet. OpenClaw gateway lifecycle is managed by an external " +
            "supervisor (OPENCLAW_SUPERVISOR_MODE=external). Use that supervisor to start the " +
            "gateway.",
        );
      });
    });
  });

  it("installs a missing gateway service when onboarding resumes before installation", async () => {
    startGatewayService.mockResolvedValueOnce({
      outcome: "missing-install",
      state: {
        installed: false,
        loaded: false,
        running: false,
        env: process.env,
        command: null,
      },
    });

    const result = await ensureGatewayServiceForOnboarding({
      flow: "quickstart",
      opts: {},
      nextConfig: {},
      settings: { port: 18789 },
      prompter: createLaterPrompter(),
      runtime: createRuntime(),
      loadedAction: "resume",
    });

    expect(result.gateway).toEqual({ status: "ready", action: "installed" });
    expect(startGatewayService).toHaveBeenCalledOnce();
    expect(buildGatewayInstallPlan).toHaveBeenCalledOnce();
    expect(gatewayServiceInstall).toHaveBeenCalledOnce();
    expect(gatewayServiceRestart).not.toHaveBeenCalled();
  });

  it("reuses a running gateway while resuming without restarting it", async () => {
    startGatewayService.mockResolvedValueOnce({
      outcome: "already-running",
      state: {
        installed: true,
        loaded: true,
        running: true,
        env: process.env,
        command: { programArguments: ["openclaw", "gateway"] },
      },
      issues: [],
    });

    const result = await ensureGatewayServiceForOnboarding({
      flow: "quickstart",
      opts: {},
      nextConfig: {},
      settings: { port: 18789 },
      prompter: createLaterPrompter(),
      runtime: createRuntime(),
      loadedAction: "resume",
    });

    expect(result.gateway).toEqual({ status: "ready", action: "reused" });
    expect(gatewayServiceRestart).not.toHaveBeenCalled();
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
    expect(startGatewayService).toHaveBeenCalledOnce();
  });

  it("starts an installed but stopped gateway while resuming", async () => {
    const stopped = {
      installed: true,
      loaded: true,
      running: false,
      env: process.env,
      command: { programArguments: ["openclaw", "gateway"] },
    };
    startGatewayService.mockResolvedValueOnce({
      outcome: "started",
      state: { ...stopped, running: true },
    });

    const result = await ensureGatewayServiceForOnboarding({
      flow: "quickstart",
      opts: {},
      nextConfig: {},
      settings: { port: 18789 },
      prompter: createLaterPrompter(),
      runtime: createRuntime(),
      loadedAction: "resume",
    });

    expect(result.gateway).toEqual({ status: "ready", action: "started" });
    expect(gatewayServiceRestart).not.toHaveBeenCalled();
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
  });

  it("reports service definition repair failures without restarting on resume", async () => {
    const prompter = createLaterPrompter();
    startGatewayService.mockResolvedValueOnce({
      outcome: "repair-required",
      state: { installed: true, loaded: true, running: false },
      issues: [
        { code: "port-mismatch", message: "service is configured for another port" },
        { code: "missing-program", message: "service command points at a missing path" },
      ],
    });

    const result = await ensureGatewayServiceForOnboarding({
      flow: "quickstart",
      opts: {},
      nextConfig: {},
      settings: { port: 18789 },
      prompter,
      runtime: createRuntime(),
      loadedAction: "resume",
    });

    expect(result.gateway).toEqual({
      status: "failed",
      error: "service is configured for another port; service command points at a missing path",
    });
    expect(
      vi
        .mocked(prompter.note)
        .mock.calls.some(([message]) => message.includes("service is configured for another port")),
    ).toBe(false);
    expect(gatewayServiceRestart).not.toHaveBeenCalled();
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
  });

  it("never prints the reusable Gateway token during classic onboarding", async () => {
    const prompter = createLaterPrompter();
    probeGatewayReachable.mockResolvedValue({ ok: true });

    await finalizeSetupWizard({
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
        gatewayToken: "session-token",
        tailscaleMode: "off",
      },
      prompter,
      runtime: createRuntime(),
    });

    const output = vi
      .mocked(prompter.note)
      .mock.calls.map((call) => call.join("\n"))
      .join("\n");
    expect(output).toContain("http://127.0.0.1:18789");
    expect(output).toContain("openclaw dashboard --no-open");
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
      expect(runTui).toHaveBeenCalledWith(
        expect.objectContaining({
          boundGateway: {
            url: "ws://127.0.0.1:18789",
            token: "test-token",
          },
          deliver: false,
          message: undefined,
          timeoutMs: 300_000,
        }),
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
          },
          prompter,
          runtime: createRuntime(),
        }),
      ).rejects.toThrow("probe failed");

      expect(runTui).not.toHaveBeenCalled();
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
      },
      prompter,
      runtime,
    });

    expect(runtime.error).not.toHaveBeenCalledWith("health failed");
    expectNoteContains(prompter, "Setup was run without Gateway service install", "Gateway");
    expectNoteTitleNotCalled(prompter, "Dashboard ready");
    expect(prompter.outro).toHaveBeenCalledWith(
      "Gateway not detected yet. Start now: openclaw gateway run",
    );
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
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(note.mock.calls.filter((call) => call[1] === "Codex native search")).toEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
