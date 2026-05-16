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
type ResolvePluginSetupProvider =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginSetupProvider;
type ResolveManifestProviderAuthChoice =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoice;
type PromptDefaultModel = typeof import("../commands/model-picker.js").promptDefaultModel;
type ApplyAuthChoice = typeof import("../commands/auth-choice.js").applyAuthChoice;

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn(async () => "skip"));
const applyAuthChoice = vi.hoisted(() =>
  vi.fn<ApplyAuthChoice>(async (args) => ({ config: args.config })),
);
const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn(async () => "demo-provider"));
const resolveManifestProviderAuthChoice = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoice>(() => undefined),
);
const resolvePluginSetupProvider = vi.hoisted(() =>
  vi.fn<ResolvePluginSetupProvider>(() => undefined),
);
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
      message: "How do you want to hatch your agent?",
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
const detectSetupMigrationSources = vi.hoisted(() => vi.fn(async () => []));
const runSetupMigrationImport = vi.hoisted(() => vi.fn(async () => {}));

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
const replaceConfigFile = vi.hoisted(() => vi.fn(async () => ({ config: {} })));
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
const createConfigIO = vi.hoisted(() =>
  vi.fn(() => ({
    readConfigFileSnapshot,
  })),
);
const ensureSystemdUserLingerInteractive = vi.hoisted(() => vi.fn(async () => {}));
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const ensureControlUiAssetsBuilt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const runTui = vi.hoisted(() => vi.fn(async (_options: unknown) => {}));
const setupWizardShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const probeGatewayReachable = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const buildPluginCompatibilitySnapshotNotices = vi.hoisted(() =>
  vi.fn((): PluginCompatibilityNotice[] => []),
);
const formatPluginCompatibilityNotice = vi.hoisted(() =>
  vi.fn((notice: PluginCompatibilityNotice) => `${notice.pluginId} ${notice.message}`),
);

function getWizardNoteCalls(note: WizardPrompter["note"]) {
  return (note as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function getMockCallArg(
  mock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
): unknown {
  const call = (mock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call[argIndex];
}

function expectMockCallArgNotNull(
  mock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
): void {
  const value = getMockCallArg(mock, callIndex, argIndex, label);
  if (value === null) {
    throw new Error(`expected ${label} arg ${argIndex} to be non-null`);
  }
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

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProvider,
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

vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources,
  runSetupMigrationImport,
}));

vi.mock("../config/config.js", () => ({
  DEFAULT_GATEWAY_PORT: 18789,
  createConfigIO,
  resolveGatewayPort,
  replaceConfigFile,
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
  buildPluginCompatibilitySnapshotNotices,
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

  it("skips provider entries without an id during preferred-provider lookup", async () => {
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
      if (message === "Setup mode") {
        return "quickstart";
      }
      if (message === "Select channel (QuickStart)") {
        return "__skip__";
      }
      if (message === "How do you want to hatch your agent?") {
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
    expectRecordFields(
      getMockCallArg(resolvePreferredProviderForAuthChoice, 0, 0, "preferred provider lookup"),
      { choice: "ollama" },
      "preferred provider lookup params",
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
    createConfigIO.mockClear();
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

    expect(createConfigIO).toHaveBeenCalledWith({ pluginValidation: "skip" });
    expect(select).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(setupChannels).not.toHaveBeenCalled();
    expect(setupSkills).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
  });
  it("persists skipBootstrap and skips workspace bootstrap creation when requested", async () => {
    ensureWorkspaceAndSessions.mockClear();
    replaceConfigFile.mockClear();

    const workspaceDir = await makeCaseDir("skip-bootstrap-");
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipBootstrap: true,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        workspace: workspaceDir,
      },
      runtime,
      prompter,
    );

    const replaceParams = requireRecord(
      getMockCallArg(replaceConfigFile, 0, 0, "config replacement"),
      "config replacement params",
    );
    const nextConfig = requireRecord(replaceParams.nextConfig, "next config");
    const agents = requireRecord(nextConfig.agents, "next config agents");
    expectRecordFields(
      requireRecord(agents.defaults, "next config agent defaults"),
      {
        skipBootstrap: true,
        workspace: workspaceDir,
      },
      "next config agent defaults",
    );
    expectRecordFields(
      replaceParams.writeOptions,
      { allowConfigSizeDrop: true },
      "config replacement write options",
    );
    expect(getMockCallArg(ensureWorkspaceAndSessions, 0, 0, "workspace setup")).toBe(workspaceDir);
    expect(getMockCallArg(ensureWorkspaceAndSessions, 0, 1, "workspace setup")).toBe(runtime);
    expectRecordFields(
      getMockCallArg(ensureWorkspaceAndSessions, 0, 2, "workspace setup"),
      { skipBootstrap: true },
      "workspace setup options",
    );
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

  async function runTuiHatchTestAndExpectLaunch(params: {
    writeBootstrapFile: boolean;
    expectedMessage: string | undefined;
  }) {
    runTui.mockClear();

    const workspaceDir = await makeCaseDir("workspace-");
    if (params.writeBootstrapFile) {
      await fs.writeFile(path.join(workspaceDir, DEFAULT_BOOTSTRAP_FILENAME), "{}");
    }

    const select = vi.fn(async (opts: WizardSelectParams<unknown>) => {
      if (opts.message === "How do you want to hatch your agent?") {
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

    expectRecordFields(
      getMockCallArg(runTui, 0, 0, "tui launch"),
      {
        local: true,
        deliver: false,
        message: params.expectedMessage,
      },
      "tui launch options",
    );
  }

  it("launches TUI without auto-delivery when hatching", async () => {
    await runTuiHatchTestAndExpectLaunch({
      writeBootstrapFile: true,
      expectedMessage: "Wake up, my friend!",
    });
  });

  it("offers TUI hatch even without BOOTSTRAP.md", async () => {
    await runTuiHatchTestAndExpectLaunch({
      writeBootstrapFile: false,
      expectedMessage: undefined,
    });
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
      const noteTitles = calls.map((call) => call?.[1]);
      expect(noteTitles).toContain("Web search");
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

    expectMockCallArgNotNull(setupChannels, 0, 0, "channel setup");
    expectMockCallArgNotNull(setupChannels, 0, 1, "channel setup");
    expectMockCallArgNotNull(setupChannels, 0, 2, "channel setup");
    expectRecordFields(
      getMockCallArg(setupChannels, 0, 3, "channel setup"),
      {
        deferStatusUntilSelection: true,
        quickstartDefaults: true,
      },
      "channel setup options",
    );
  });

  it("prompts for a model during explicit interactive Ollama setup", async () => {
    promptDefaultModel.mockClear();
    warnIfModelConfigLooksOff.mockClear();
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

    expectRecordFields(
      getMockCallArg(promptDefaultModel, 0, 0, "default model prompt"),
      {
        allowKeep: false,
        browseCatalogOnDemand: true,
      },
      "default model prompt params",
    );
    expectMockCallArgNotNull(warnIfModelConfigLooksOff, 0, 0, "model warning");
    expectMockCallArgNotNull(warnIfModelConfigLooksOff, 0, 1, "model warning");
    expectRecordFields(
      getMockCallArg(warnIfModelConfigLooksOff, 0, 2, "model warning"),
      { validateCatalog: false },
      "model warning options",
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
    expectRecordFields(
      getMockCallArg(applyAuthChoice, 1, 0, "retry auth choice"),
      {
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
      },
      "retry auth choice params",
    );
  });

  it("forwards provider-specific auth flags to applyAuthChoice opts", async () => {
    applyAuthChoice.mockReset();
    applyAuthChoice.mockResolvedValueOnce({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.5",
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
        authChoice: "openai-codex-api-key",
        openaiApiKey: "sk-flag-value",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        skipHooks: true,
      },
      runtime,
      prompter,
    );

    expect(applyAuthChoice).toHaveBeenCalledTimes(1);
    const call = getMockCallArg(applyAuthChoice, 0, 0, "openai-codex auth choice");
    const opts = (call as { opts?: Record<string, unknown> }).opts ?? {};
    expect(opts.openaiApiKey).toBe("sk-flag-value");
  });

  it("shows plugin compatibility notices for an existing valid config", async () => {
    buildPluginCompatibilitySnapshotNotices.mockReturnValue([
      {
        pluginId: "legacy-plugin",
        code: "legacy-before-agent-start",
        compatCode: "legacy-before-agent-start",
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
    const noteTitles = calls.map((call) => call?.[1]);
    expect(noteTitles).toContain("Plugin compatibility");
    const noteBodies = calls
      .map((call) => call?.[0])
      .filter((body): body is string => typeof body === "string");
    const legacyPluginNotes = noteBodies.filter((body) => body.includes("legacy-plugin"));
    expect(legacyPluginNotes.length).toBeGreaterThan(0);
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

    expectRecordFields(
      getMockCallArg(probeGatewayReachable, 0, 0, "gateway probe"),
      {
        url: "ws://127.0.0.1:18789",
        password: "gateway-ref-password", // pragma: allowlist secret
      },
      "gateway probe params",
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

    expectRecordFields(
      getMockCallArg(configureGatewayForSetup, 0, 0, "gateway setup"),
      {
        secretInputMode: "ref", // pragma: allowlist secret
      },
      "gateway setup params",
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
    const matchingQuickStartNotes = calls.filter(
      (call) =>
        call?.[1] === "QuickStart" &&
        typeof call?.[0] === "string" &&
        call[0].includes("Gateway port: 18791"),
    );
    expect(matchingQuickStartNotes.length).toBeGreaterThan(0);
  });

  it("localizes the quickstart summary", async () => {
    const previousPort = process.env.OPENCLAW_GATEWAY_PORT;
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_GATEWAY_PORT = "18791";
    process.env.OPENCLAW_LOCALE = "zh-CN";
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
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }

    const calls = (note as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const matchingQuickStartNotes = calls.filter(
      (call) =>
        call?.[1] === "QuickStart" &&
        typeof call?.[0] === "string" &&
        call[0].includes("Gateway 端口：18791") &&
        call[0].includes("Tailscale 暴露方式：关闭"),
    );
    expect(matchingQuickStartNotes.length).toBeGreaterThan(0);
  });

  it("uses manifest setup metadata for post-auth model policy without loading provider runtime", async () => {
    promptDefaultModel.mockClear();
    resolvePluginProvidersRuntime.mockClear();
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "openai",
      providerId: "openai-codex",
      methodId: "oauth",
      choiceId: "openai-codex",
      choiceLabel: "ChatGPT/Codex Browser Login",
    });
    resolvePluginSetupProvider.mockReturnValue({
      id: "openai-codex",
      label: "OpenAI Codex",
      auth: [
        {
          id: "oauth",
          label: "ChatGPT/Codex Browser Login",
          kind: "oauth",
          wizard: {
            modelSelection: {
              allowKeepCurrent: false,
            },
          },
          run: vi.fn(async () => ({ profiles: [] })),
        },
      ],
    });
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai-codex");
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        installDaemon: false,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expectRecordFields(
      getMockCallArg(resolvePluginSetupProvider, 0, 0, "plugin setup provider"),
      {
        provider: "openai-codex",
        pluginIds: ["openai"],
      },
      "plugin setup provider params",
    );
    expect(resolvePluginProvidersRuntime).not.toHaveBeenCalled();
    expectRecordFields(
      getMockCallArg(promptDefaultModel, 0, 0, "default model prompt"),
      { allowKeep: false },
      "default model prompt params",
    );
  });
});
