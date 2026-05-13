import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
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
const setupWizardShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async () => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
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

vi.mock("../commands/onboard-helpers.js", () => ({
  detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
  openUrl: vi.fn(async () => false),
  probeGatewayReachable,
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  waitForGatewayReachable,
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

vi.mock("../terminal/restore.js", () => ({
  restoreTerminalState,
}));

vi.mock("../tui/tui-launch.js", () => ({
  launchTuiCli,
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
    "id" | "label" | "hint" | "envVars" | "placeholder" | "signupUrl" | "credentialPath"
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

describe("finalizeSetupWizard", () => {
  beforeEach(() => {
    launchTuiCli.mockClear();
    restoreTerminalState.mockClear();
    probeGatewayReachable.mockClear();
    waitForGatewayReachable.mockReset();
    waitForGatewayReachable.mockResolvedValue({ ok: true });
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
    expect(launchTuiCli).toHaveBeenCalledWith({
      local: true,
      deliver: false,
      message: undefined,
      timeoutMs: 300_000,
    });
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

    expect(launchTuiCli).toHaveBeenCalledWith({
      local: true,
      deliver: false,
      message: "Wake up, my friend!",
      timeoutMs: 300_000,
    });
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
      resumeStdinIfPaused: true,
    });
    expect(restoreTerminalState).toHaveBeenCalledWith("post-setup tui", {
      resumeStdinIfPaused: true,
    });
  });

  it("does not persist resolved SecretRef token in daemon install plan", async () => {
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: vi.fn(async () => false),
    });
    const runtime = createRuntime();

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
    expect(gatewayServiceInstall).toHaveBeenCalledTimes(1);
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
    expect(progressUpdate).toHaveBeenCalledWith("Restarting Gateway service…");
    expect(progressStop).toHaveBeenCalledWith("Gateway service restart scheduled.");
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
    hasExistingKey.mockImplementation((_config, provider) => provider === "perplexity");

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
    hasExistingKey.mockImplementation((_config, provider) => provider === "firecrawl");

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
