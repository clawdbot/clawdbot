import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter, WizardSelectParams } from "./prompts.js";
import { runSetupWizard } from "./setup.js";

type ResolveProviderPluginChoice =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolveProviderPluginChoice;
type ResolvePluginProvidersRuntime =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginProviders;
type PromptDefaultModel = typeof import("../commands/model-picker.js").promptDefaultModel;
type ApplyAuthChoice = typeof import("../commands/auth-choice.js").applyAuthChoice;

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn(async () => "skip"));
const applyAuthChoice = vi.hoisted(() =>
  vi.fn<ApplyAuthChoice>(async (args) => ({ config: args.config })),
);
const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn(async () => "demo-provider"));
const resolveProviderPluginChoice = vi.hoisted(() =>
  vi.fn<ResolveProviderPluginChoice>(() => null),
);
const resolvePluginProvidersRuntime = vi.hoisted(() =>
  vi.fn<ResolvePluginProvidersRuntime>(() => []),
);
const warnIfModelConfigLooksOff = vi.hoisted(() => vi.fn(async () => {}));
const applyPrimaryModel = vi.hoisted(() => vi.fn((cfg) => cfg));
const promptDefaultModel = vi.hoisted(() => vi.fn<PromptDefaultModel>(async () => ({})));
const promptCustomApiConfig = vi.hoisted(() => vi.fn(async (args) => ({ config: args.config })));
const configureGatewayForSetup = vi.hoisted(() =>
  vi.fn(async (args) => ({
    nextConfig: args.nextConfig,
    settings: {
      port: args.localPort ?? 18789,
      bind: "loopback",
      authMode: "token",
      gatewayToken: "test-token",
      tailscaleMode: "off",
      tailscaleResetOnExit: false,
    },
  })),
);
const finalizeSetupWizard = vi.hoisted(() =>
  vi.fn(async (options) => {
    if (!options.nextConfig?.tools?.web?.search?.provider) {
      await options.prompter.note("Web search was skipped.", "Web search");
    }

    if (options.opts.skipUi) {
      return { launchedTui: false };
    }

    const hatch = await options.prompter.select({
      message: "How do you want to hatch your bot?",
      options: [],
    });
    if (hatch !== "tui") {
      return { launchedTui: false };
    }

    let message: string | undefined;
    try {
      await fs.stat(path.join(options.workspaceDir, DEFAULT_BOOTSTRAP_FILENAME));
      message = "Wake up, my friend!";
    } catch {
      message = undefined;
    }

    await runTui({ local: true, deliver: false, message });
    return { launchedTui: true };
  }),
);
const listChannelPlugins = vi.hoisted(() => vi.fn(() => []));
const logConfigUpdated = vi.hoisted(() => vi.fn(() => {}));
const setupInternalHooks = vi.hoisted(() => vi.fn(async (cfg) => cfg));

const setupChannels = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const setupSkills = vi.hoisted(() => vi.fn(async (cfg) => cfg));

function providerPluginStub(
  overrides: Partial<ProviderPlugin> & Pick<ProviderPlugin, "id">,
): ProviderPlugin {
  const { id, ...rest } = overrides;
  return {
    id,
    label: id || "provider",
    auth: [],
    ...rest,
  };
}
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const ensureWorkspaceAndSessions = vi.hoisted(() => vi.fn(async () => {}));
const writeConfigFile = vi.hoisted(() => vi.fn(async () => {}));
const resolveGatewayPort = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, env?: NodeJS.ProcessEnv) => {
    const raw = env?.OPENCLAW_GATEWAY_PORT ?? process.env.OPENCLAW_GATEWAY_PORT;
    const port = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(port) && port > 0 ? port : 18789;
  }),
);
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    path: "/tmp/.openclaw/openclaw.json",
    exists: false,
    raw: null as string | null,
    parsed: {},
    resolved: {},
    valid: true,
    config: {},
    issues: [] as Array<{ path: string; message: string }>,
    warnings: [] as Array<{ path: string; message: string }>,
    legacyIssues: [] as Array<{ path: string; message: string }>,
  })),
);
const ensureSystemdUserLingerInteractive = vi.hoisted(() => vi.fn(async () => {}));
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const ensureControlUiAssetsBuilt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const runTui = vi.hoisted(() => vi.fn(async (_options: unknown) => {}));
const setupWizardShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const probeGatewayReachable = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const buildPluginCompatibilityNotices = vi.hoisted(() =>
  vi.fn((): PluginCompatibilityNotice[] => []),
);
const formatPluginCompatibilityNotice = vi.hoisted(() =>
  vi.fn((notice: PluginCompatibilityNotice) => `${notice.pluginId} ${notice.message}`),
);

function getWizardNoteCalls(note: WizardPrompter["note"]) {
  return (note as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

vi.mock("../commands/onboard-channels.js", () => ({
  setupChannels,
}));

vi.mock("../commands/onboard-skills.js", () => ({
  setupSkills,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
}));

vi.mock("../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore,
}));

vi.mock("../commands/auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped,
}));

vi.mock("../commands/auth-choice.js", () => ({
  applyAuthChoice,
  resolvePreferredProviderForAuthChoice,
  warnIfModelConfigLooksOff,
}));

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolveProviderPluginChoice,
  resolvePluginProviders: resolvePluginProvidersRuntime,
}));

vi.mock("../commands/model-picker.js", () => ({
  applyPrimaryModel,
  promptDefaultModel,
}));

vi.mock("../commands/onboard-custom.js", () => ({
  promptCustomApiConfig,
}));

vi.mock("../commands/health.js", () => ({
  healthCommand,
}));

vi.mock("../commands/onboard-hooks.js", () => ({
  setupInternalHooks,
}));

vi.mock("../config/config.js", () => ({
  DEFAULT_GATEWAY_PORT: 18789,
  resolveGatewayPort,
  readConfigFileSnapshot,
  writeConfigFile,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  applyWizardMetadata: (cfg: unknown) => cfg,
  summarizeExistingConfig: () => "summary",
  handleReset: async () => {},
  randomToken: () => "test-token",
  normalizeGatewayTokenInput: (value: unknown) => ({
    ok: true,
    token: typeof value === "string" ? value.trim() : "",
    error: null,
  }),
  validateGatewayPasswordInput: () => ({ ok: true, error: null }),
  ensureWorkspaceAndSessions,
  detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
  openUrl: vi.fn(async () => true),
  printWizardHeader: vi.fn(),
  probeGatewayReachable,
  waitForGatewayReachable: vi.fn(async () => {}),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
}));

vi.mock("../commands/systemd-linger.js", () => ({
  ensureSystemdUserLingerInteractive,
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilityNotices,
  formatPluginCompatibilityNotice,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins,
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated,
}));

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

vi.mock("./setup.gateway-config.js", () => ({
  configureGatewayForSetup,
}));

vi.mock("./setup.finalize.js", () => ({
  finalizeSetupWizard,
}));

vi.mock("./setup.completion.js", () => ({
  setupWizardShellCompletion,
}));

function createRuntime(opts?: { throwsOnExit?: boolean }): RuntimeEnv {
  if (opts?.throwsOnExit) {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };
  }

  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("runSetupWizard", () => {
  let suiteRoot = "";
  let suiteCase = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onboard-suite-"));
  });

  afterAll(async () => {
    await fs.rm(suiteRoot, { recursive: true, force: true });
    suiteRoot = "";
    suiteCase = 0;
  });

  async function makeCaseDir(prefix: string): Promise<string> {
    const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  it("does not crash when preferred-provider lookup sees a provider without an id", async () => {
    setupChannels.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {},
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    resolvePreferredProviderForAuthChoice.mockResolvedValueOnce("demo-provider");
    resolvePluginProvidersRuntime.mockReturnValueOnce([
      providerPluginStub({ id: "" }),
      providerPluginStub({ id: "demo-provider", wizard: { setup: {} } }),
    ]);

    const caseDir = await makeCaseDir("provider-missing-id-");
    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) => {
      if (message === "Select setup mode") {
        return "quickstart";
      }
      if (message === "Select channel (QuickStart)") {
        return "__skip__";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "skip";
    }) as unknown as WizardPrompter["select"];
    const confirm = vi.fn(async () => true) as unknown as WizardPrompter["confirm"];
    const prompter = buildWizardPrompter({ select, confirm });
    const runtime = createRuntime({ throwsOnExit: true });

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "ollama",
          installDaemon: false,
          skipProviders: false,
          skipSkills: true,
          skipSearch: true,
          skipChannels: false,
          skipUi: true,
          workspace: caseDir,
        },
        runtime,
        prompter,
      ),
    ).resolves.toBeUndefined();
    expect(resolvePreferredProviderForAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({ choice: "ollama" }),
    );
    expect(resolvePluginProvidersRuntime).toHaveBeenCalled();
    setupChannels.mockClear();
  });

  it("exits when config is invalid", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: false,
      config: {},
      issues: [{ path: "routing.allowFrom", message: "Legacy key" }],
      warnings: [],
      legacyIssues: [{ path: "routing.allowFrom", message: "Legacy key" }],
    });

    const select = vi.fn(
      async (_params: WizardSelectParams<unknown>) => "quickstart",
    ) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime({ throwsOnExit: true });

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      ),
    ).rejects.toThrow("exit:1");

    expect(select).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalled();
  });

  it("skips prompts and setup steps when flags are set", async () => {
    const select = vi.fn(
      async (_params: WizardSelectParams<unknown>) => "quickstart",
    ) as unknown as WizardPrompter["select"];
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = buildWizardPrompter({ select, multiselect });
    const runtime = createRuntime({ throwsOnExit: true });
    ensureAuthProfileStore.mockClear();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(select).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(setupChannels).not.toHaveBeenCalled();
    expect(setupSkills).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
  });

  it("fails fast if the auth choice prompt returns nothing", async () => {
    promptAuthChoiceGrouped.mockImplementationOnce(async () => undefined as never);
    const prompter = buildWizardPrompter();
    const runtime = createRuntime();

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      ),
    ).rejects.toThrow("auth choice is required");
  });

  async function runTuiHatchTest(params: {
    writeBootstrapFile: boolean;
    expectedMessage: string | undefined;
  }) {
    runTui.mockClear();

    const workspaceDir = await makeCaseDir("workspace-");
    if (params.writeBootstrapFile) {
      await fs.writeFile(path.join(workspaceDir, DEFAULT_BOOTSTRAP_FILENAME), "{}");
    }

    const select = vi.fn(async (opts: WizardSelectParams<unknown>) => {
      if (opts.message === "How do you want to hatch your bot?") {
        return "tui";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];

    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime({ throwsOnExit: true });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        mode: "local",
        workspace: workspaceDir,
        authChoice: "skip",
        skipProviders: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        installDaemon: false,
      },
      runtime,
      prompter,
    );

    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        deliver: false,
        message: params.expectedMessage,
      }),
    );
  }

  it("launches TUI without auto-delivery when hatching", async () => {
    await runTuiHatchTest({ writeBootstrapFile: true, expectedMessage: "Wake up, my friend!" });
  });

  it("offers TUI hatch even without BOOTSTRAP.md", async () => {
    await runTuiHatchTest({ writeBootstrapFile: false, expectedMessage: undefined });
  });

  it("shows the web search hint at the end of setup", async () => {
    const prevBraveKey = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;

    try {
      const note: WizardPrompter["note"] = vi.fn(async () => {});
      const prompter = buildWizardPrompter({ note });
      const runtime = createRuntime();

      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      );

      const calls = getWizardNoteCalls(note);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((call) => call?.[1] === "Web search")).toBe(true);
    } finally {
      if (prevBraveKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = prevBraveKey;
      }
    }
  });

  it("defers channel setup plugin loads during QuickStart until a channel is selected", async () => {
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipChannels: false,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(setupChannels).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        deferStatusUntilSelection: true,
        quickstartDefaults: true,
      }),
    );
  });

  it("prompts for a model during explicit interactive Ollama setup", async () => {
    promptDefaultModel.mockClear();
    resolveProviderPluginChoice.mockReturnValue({
      provider: {
        id: "ollama",
        label: "Ollama",
        auth: [],
        wizard: {
          setup: {
            modelSelection: {
              promptWhenAuthChoiceProvided: true,
              allowKeepCurrent: false,
            },
          },
        },
      },
      method: {
        id: "local",
        label: "Ollama",
        kind: "custom",
        run: vi.fn(async () => ({ profiles: [] })),
      },
      wizard: {
        modelSelection: {
          promptWhenAuthChoiceProvided: true,
          allowKeepCurrent: false,
        },
      },
    });
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "ollama",
        installDaemon: false,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(promptDefaultModel).toHaveBeenCalledWith(
      expect.objectContaining({
        allowKeep: false,
      }),
    );
  });

  it("re-prompts for auth when applyAuthChoice requests retry selection", async () => {
    promptAuthChoiceGrouped.mockReset();
    promptAuthChoiceGrouped
      .mockResolvedValueOnce("demo-provider-one")
      .mockResolvedValueOnce("demo-provider-two");
    applyAuthChoice.mockReset();
    applyAuthChoice
      .mockResolvedValueOnce({
        config: {
          plugins: {
            entries: {
              "demo-provider-plugin": {
                enabled: true,
              },
            },
          },
        },
        retrySelection: true,
      })
      .mockResolvedValueOnce({
        config: {
          agents: {
            defaults: {
              model: {
                primary: "demo-provider-two/model",
              },
            },
          },
        },
      });

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(applyAuthChoice).toHaveBeenCalledTimes(2);
    expect(applyAuthChoice).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authChoice: "demo-provider-two",
        config: {
          plugins: {
            entries: {
              "demo-provider-plugin": {
                enabled: true,
              },
            },
          },
        },
      }),
    );
  });

  it("shows plugin compatibility notices for an existing valid config", async () => {
    buildPluginCompatibilityNotices.mockReturnValue([
      {
        pluginId: "legacy-plugin",
        code: "legacy-before-agent-start",
        severity: "warn",
        message:
          "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
      },
    ]);
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {},
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });

    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const select = vi.fn(async (opts: WizardSelectParams<unknown>) => {
      if (opts.message === "Config handling") {
        return "keep";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ note, select });
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    const calls = getWizardNoteCalls(note);
    expect(calls.some((call) => call?.[1] === "Plugin compatibility")).toBe(true);
    expect(
      calls.some((call) => {
        const body = call?.[0];
        return typeof body === "string" && body.includes("legacy-plugin");
      }),
    ).toBe(true);
  });

  it("resolves gateway.auth.password SecretRef for local setup probe", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "gateway-ref-password"; // pragma: allowlist secret
    probeGatewayReachable.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
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
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    const select = vi.fn(async (opts: WizardSelectParams<unknown>) => {
      if (opts.message === "Config handling") {
        return "keep";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime();

    try {
      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          mode: "local",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    expect(probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        password: "gateway-ref-password", // pragma: allowlist secret
      }),
    );
  });

  it("passes secretInputMode through to local gateway config step", async () => {
    configureGatewayForSetup.mockClear();
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        mode: "local",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        secretInputMode: "ref", // pragma: allowlist secret
      },
      runtime,
      prompter,
    );

    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        secretInputMode: "ref", // pragma: allowlist secret
      }),
    );
  });

  it("shows the resolved gateway port in quickstart for fresh envs", async () => {
    const previousPort = process.env.OPENCLAW_GATEWAY_PORT;
    process.env.OPENCLAW_GATEWAY_PORT = "18791";
    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const prompter = buildWizardPrompter({ note });
    const runtime = createRuntime();

    try {
      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      );
    } finally {
      if (previousPort === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PORT;
      } else {
        process.env.OPENCLAW_GATEWAY_PORT = previousPort;
      }
    }

    const calls = (note as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      calls.some(
        (call) =>
          call?.[1] === "QuickStart" &&
          typeof call?.[0] === "string" &&
          call[0].includes("Gateway port: 18791"),
      ),
    ).toBe(true);
  });
});
