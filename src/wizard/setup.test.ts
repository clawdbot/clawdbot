// Setup wizard tests cover end-to-end onboarding prompt flows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
} from "../agents/auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { ProviderAuthResult } from "../plugins/types.js";
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
type PrepareAuthChoice = typeof import("../commands/auth-choice.js").prepareAuthChoice;
type VerifySetupInferenceConfig =
  typeof import("../system-agent/setup-inference.js").verifySetupInferenceConfig;
type ConfigureGatewayForSetup = typeof import("./setup.gateway-config.js").configureGatewayForSetup;

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));
const keepCurrentAuthChoice = vi.hoisted(() => "__keep-current" as const);
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn(async () => "skip"));
const applyAuthChoice = vi.hoisted(() =>
  vi.fn<ApplyAuthChoice>(async (args) => ({ config: args.config })),
);
const prepareAuthChoice = vi.hoisted(() =>
  vi.fn<PrepareAuthChoice>(async (args) => ({
    ...(await applyAuthChoice(args)),
    authProfiles: [],
    persistAuthProfiles: async () => {},
  })),
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
  vi.fn<ConfigureGatewayForSetup>(async (args) => ({
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
const enableDefaultOnboardingInternalHooks = vi.hoisted(() =>
  vi.fn((cfg) => ({
    ...cfg,
    hooks: {
      ...(cfg as { hooks?: Record<string, unknown> }).hooks,
      internal: {
        ...(cfg as { hooks?: { internal?: Record<string, unknown> } }).hooks?.internal,
        entries: {
          ...(cfg as { hooks?: { internal?: { entries?: Record<string, unknown> } } }).hooks
            ?.internal?.entries,
          "session-memory": { enabled: true },
        },
      },
    },
  })),
);
const detectSetupMigrationSources = vi.hoisted(() => vi.fn(async () => []));
const listSetupMigrationOptions = vi.hoisted(() => vi.fn(async () => []));
const runSetupMigrationImport = vi.hoisted(() => vi.fn(async () => {}));
const runSetupMemoryImportStep = vi.hoisted(() => vi.fn(async () => {}));
const verifySetupInferenceConfig = vi.hoisted(() =>
  vi.fn<VerifySetupInferenceConfig>(async () => ({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 250,
  })),
);

const setupChannels = vi.hoisted(() =>
  vi.fn(
    async (cfg: unknown, _runtime?: unknown, _prompter?: WizardPrompter, _options?: unknown) => cfg,
  ),
);
const setupSkills = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const promptRemoteGatewayConfig = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const validateGatewayWebSocketUrl = vi.hoisted(() =>
  vi.fn<(value: string) => string | undefined>(() => undefined),
);

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

function modelConfigWithApiKey(apiKey: string): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    auth: {
      profiles: { "openai:default": { provider: "openai", mode: "api_key" } },
      order: { openai: ["openai:default"] },
    },
    models: {
      providers: {
        openai: {
          apiKey,
          baseUrl: "https://api.openai.com/v1",
          models: [],
        },
      },
    },
  };
}

function stagedOpenAiProfile(apiKey: string) {
  return {
    profileId: "openai:default",
    credential: { type: "api_key" as const, provider: "openai", key: apiKey },
  };
}

function prepareMockAuthProfilesIn(
  agentDir: string,
): Array<ProviderAuthResult["profiles"] | undefined> {
  const persistCalls: Array<ProviderAuthResult["profiles"] | undefined> = [];
  prepareAuthChoice.mockImplementation(async (args) => {
    const result = await applyAuthChoice(args);
    const apiKey = result.config.models?.providers?.openai?.apiKey;
    if (typeof apiKey !== "string") {
      return {
        ...result,
        authProfiles: [],
        persistAuthProfiles: async () => {},
      };
    }
    const profile = stagedOpenAiProfile(apiKey);
    return {
      ...result,
      authProfiles: [profile],
      persistAuthProfiles: async (profiles) => {
        persistCalls.push(profiles);
        for (const candidate of profiles ?? [profile]) {
          const updated = await upsertAuthProfileWithLock({ ...candidate, agentDir });
          if (!updated) {
            throw new Error("test auth profile write failed");
          }
        }
      },
    };
  });
  return persistCalls;
}

function persistedWizardConfigs(): OpenClawConfig[] {
  return (replaceConfigFile.mock.calls as unknown[][]).map(
    ([params]) => (params as { nextConfig: OpenClawConfig }).nextConfig,
  );
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

vi.mock("../commands/onboard-remote.js", () => ({
  promptRemoteGatewayConfig,
  validateGatewayWebSocketUrl,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
}));

vi.mock("../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore,
}));

vi.mock("../commands/auth-choice-prompt.js", () => ({
  KEEP_CURRENT_AUTH_CHOICE: keepCurrentAuthChoice,
  promptAuthChoiceGrouped,
}));

vi.mock("../commands/auth-choice.js", () => ({
  applyAuthChoice,
  prepareAuthChoice,
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
  enableDefaultOnboardingInternalHooks,
  setupInternalHooks,
}));

vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources,
  listSetupMigrationOptions,
  runSetupMigrationImport,
}));

vi.mock("./setup.memory-import.js", () => ({
  runSetupMemoryImportStep,
}));

vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInferenceConfig,
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

  function configSnapshot(config: OpenClawConfig, exists = true) {
    return {
      path: "/tmp/.openclaw/openclaw.json",
      exists,
      raw: exists ? "{}" : null,
      parsed: config,
      resolved: config,
      valid: true as const,
      config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    promptAuthChoiceGrouped.mockReset();
    promptAuthChoiceGrouped.mockResolvedValue("skip");
    applyAuthChoice.mockReset();
    applyAuthChoice.mockImplementation(async (args) => ({ config: args.config }));
    prepareAuthChoice.mockReset();
    prepareAuthChoice.mockImplementation(async (args) => ({
      ...(await applyAuthChoice(args)),
      authProfiles: [],
      persistAuthProfiles: async () => {},
    }));
    setupChannels.mockReset();
    setupChannels.mockImplementation(async (cfg) => cfg);
    setupSkills.mockReset();
    setupSkills.mockImplementation(async (cfg) => cfg);
    promptRemoteGatewayConfig.mockReset();
    promptRemoteGatewayConfig.mockImplementation(async (cfg) => cfg);
    validateGatewayWebSocketUrl.mockReset();
    validateGatewayWebSocketUrl.mockReturnValue(undefined);
    configureGatewayForSetup.mockReset();
    configureGatewayForSetup.mockImplementation(async (args) => ({
      nextConfig: args.nextConfig,
      settings: {
        port: args.localPort ?? 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "test-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
    }));
    readConfigFileSnapshot.mockReset();
    readConfigFileSnapshot.mockResolvedValue(configSnapshot({}, false));
    probeGatewayReachable.mockReset();
    probeGatewayReachable.mockResolvedValue({ ok: false });
    resolvePreferredProviderForAuthChoice.mockReset();
    resolvePreferredProviderForAuthChoice.mockResolvedValue("demo-provider");
    resolvePluginProvidersRuntime.mockReset();
    resolvePluginProvidersRuntime.mockReturnValue([]);
    resolveManifestProviderAuthChoice.mockReset();
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolvePluginSetupProvider.mockReset();
    resolvePluginSetupProvider.mockReturnValue(undefined);
    resolveProviderPluginChoice.mockReset();
    resolveProviderPluginChoice.mockReturnValue(null);
    promptDefaultModel.mockReset();
    promptDefaultModel.mockResolvedValue({});
    warnIfModelConfigLooksOff.mockReset();
    warnIfModelConfigLooksOff.mockResolvedValue(undefined);
    buildPluginCompatibilitySnapshotNotices.mockReset();
    buildPluginCompatibilitySnapshotNotices.mockReturnValue([]);
    verifySetupInferenceConfig.mockReset();
    verifySetupInferenceConfig.mockResolvedValue({
      ok: true,
      modelRef: "openai/gpt-5.5",
      latencyMs: 250,
    });
    runSetupMemoryImportStep.mockReset();
    runSetupMemoryImportStep.mockResolvedValue(undefined);
  });

  it("exits successfully after the auto-launched TUI returns", async () => {
    const caseDir = await makeCaseDir("tui-success-exit-");
    await fs.writeFile(path.join(caseDir, DEFAULT_BOOTSTRAP_FILENAME), "");
    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) => {
      if (message === "How do you want to hatch your agent?") {
        return "tui";
      }
      return "__skip__";
    }) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime({ throwsOnExit: true });

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipChannels: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: false,
          workspace: caseDir,
        },
        runtime,
        prompter,
      ),
    ).rejects.toThrow("exit:0");

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      deliver: false,
      message: "Wake up, my friend!",
    });
  });

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
          skipChannels: true,
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
    const plain: WizardPrompter["plain"] = vi.fn(async () => {});
    const prompter = buildWizardPrompter({ select, multiselect, plain });
    const runtime = createRuntime({ throwsOnExit: true });
    createConfigIO.mockClear();
    ensureAuthProfileStore.mockClear();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
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

    expect(createConfigIO).toHaveBeenCalledWith({ pluginValidation: "skip" });
    expect(plain).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(setupChannels).not.toHaveBeenCalled();
    expect(setupSkills).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
  });

  it("seeds interactive remote setup from command flags", async () => {
    const remoteToken = "REDACTED";
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {
          remote: {
            url: "wss://stored.example.com:18789",
            token: { source: "env", provider: "default", id: "STORED_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "STORED_GATEWAY_PASSWORD" },
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        mode: "remote",
        remoteUrl: " wss://flag.example.com:18789 ",
        remoteToken: ` ${remoteToken} `,
      },
      runtime,
      prompter,
    );

    expect(probeGatewayReachable).toHaveBeenCalledWith({
      url: "wss://flag.example.com:18789",
      token: remoteToken,
    });
    expect(promptRemoteGatewayConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({
          remote: {
            url: "wss://flag.example.com:18789",
            token: remoteToken,
            password: undefined,
          },
        }),
      }),
      expect.any(Object),
      { secretInputMode: undefined },
    );
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining(remoteToken));
  });

  it("does not reuse stored remote credentials for an overridden URL", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {
          remote: {
            url: "wss://stored.example.com:18789",
            token: { source: "env", provider: "default", id: "STORED_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "STORED_GATEWAY_PASSWORD" },
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        mode: "remote",
        remoteUrl: "wss://flag.example.com:18789",
      },
      createRuntime(),
      buildWizardPrompter({}),
    );

    expect(probeGatewayReachable).toHaveBeenCalledWith({
      url: "wss://flag.example.com:18789",
      token: undefined,
    });
    expect(promptRemoteGatewayConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({
          remote: {
            url: "wss://flag.example.com:18789",
            token: undefined,
            password: undefined,
          },
        }),
      }),
      expect.any(Object),
      { secretInputMode: undefined },
    );
  });

  it("does not probe an invalid CLI remote URL with its token", async () => {
    const remoteToken = "REDACTED";
    validateGatewayWebSocketUrl.mockReturnValueOnce("Use wss:// for public gateways");

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        mode: "remote",
        remoteUrl: "ws://public.example",
        remoteToken,
      },
      createRuntime(),
      buildWizardPrompter({}),
    );

    expect(validateGatewayWebSocketUrl).toHaveBeenCalledWith("ws://public.example");
    expect(probeGatewayReachable).not.toHaveBeenCalledWith({
      url: "ws://public.example",
      token: remoteToken,
    });
  });

  it("auto-enables the bundled session-memory hook without showing the hooks screen", async () => {
    replaceConfigFile.mockClear();
    setupInternalHooks.mockClear();
    enableDefaultOnboardingInternalHooks.mockClear();
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime({ throwsOnExit: true });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
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

    expect(setupInternalHooks).not.toHaveBeenCalled();
    expect(enableDefaultOnboardingInternalHooks).toHaveBeenCalledOnce();
    const finalCallIndex = replaceConfigFile.mock.calls.length - 1;
    const replaceParams = requireRecord(
      getMockCallArg(replaceConfigFile, finalCallIndex, 0, "final config replacement"),
      "final config replacement params",
    );
    const nextConfig = requireRecord(replaceParams.nextConfig, "next config");
    const hooks = requireRecord(nextConfig.hooks, "next config hooks");
    const internal = requireRecord(hooks.internal, "next config internal hooks");
    const entries = requireRecord(internal.entries, "next config hook entries");
    expect(entries["session-memory"]).toEqual({ enabled: true });
  });

  it("does not auto-enable default hooks when skipHooks is set", async () => {
    replaceConfigFile.mockClear();
    enableDefaultOnboardingInternalHooks.mockClear();
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime({ throwsOnExit: true });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
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

    expect(enableDefaultOnboardingInternalHooks).not.toHaveBeenCalled();
    const finalCallIndex = replaceConfigFile.mock.calls.length - 1;
    const replaceParams = requireRecord(
      getMockCallArg(replaceConfigFile, finalCallIndex, 0, "final config replacement"),
      "final config replacement params",
    );
    expect(requireRecord(replaceParams.nextConfig, "next config").hooks).toBeUndefined();
  });

  it("persists the first security acknowledgement", async () => {
    replaceConfigFile.mockClear();
    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const confirm = vi.fn(async () => true) as unknown as WizardPrompter["confirm"];
    const prompter = buildWizardPrompter({ note, confirm });
    const runtime = createRuntime({ throwsOnExit: true });

    await runSetupWizard(
      {
        flow: "quickstart",
        authChoice: "skip",
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

    const calls = getWizardNoteCalls(note);
    expect(calls[0]?.[1]).toBe("Security disclaimer");
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: true,
        layout: "vertical",
      }),
    );
    const replaceParams = requireRecord(
      getMockCallArg(replaceConfigFile, 0, 0, "config replacement"),
      "config replacement params",
    );
    expect(
      requireRecord(requireRecord(replaceParams.nextConfig, "next config").wizard, "wizard")
        .securityAcknowledgedAt,
    ).toEqual(expect.any(String));
  });

  it("skips the security acknowledgement after it was accepted once", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: { wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" } },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const confirm = vi.fn(async () => true) as unknown as WizardPrompter["confirm"];
    const prompter = buildWizardPrompter({ note, confirm });
    const runtime = createRuntime({ throwsOnExit: true });

    await runSetupWizard(
      {
        flow: "quickstart",
        authChoice: "skip",
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

    const titles = getWizardNoteCalls(note).map((call) => call?.[1]);
    expect(titles).not.toContain("Security disclaimer");
    expect(confirm).not.toHaveBeenCalled();
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
      { allowConfigSizeDrop: false },
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

  it("runs memory import after workspace bootstrap in QuickStart", async () => {
    const workspaceDir = await makeCaseDir("memory-import-step-");
    const prompter = buildWizardPrompter();
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
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

    expect(runSetupMemoryImportStep).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({ workspace: workspaceDir }),
          }),
        }),
        runtime,
      }),
    );
    expect(ensureWorkspaceAndSessions.mock.invocationCallOrder[0]).toBeLessThan(
      runSetupMemoryImportStep.mock.invocationCallOrder[0]!,
    );
  });

  it("does not run the memory page after the full import flow", async () => {
    const workspaceDir = await makeCaseDir("full-import-flow-");
    const prompter = buildWizardPrompter();
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        importFrom: "hermes",
        authChoice: "skip",
        installDaemon: false,
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

    expect(runSetupMigrationImport).toHaveBeenCalledOnce();
    expect(runSetupMemoryImportStep).not.toHaveBeenCalled();
  });

  it("requires a live check before keeping an imported default model", async () => {
    const workspaceDir = await makeCaseDir("verified-import-flow-");
    const importedConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
    };
    readConfigFileSnapshot
      .mockResolvedValueOnce(configSnapshot({}, false))
      .mockResolvedValue(configSnapshot(importedConfig));
    const confirm = vi.fn(async () => true) as unknown as WizardPrompter["confirm"];
    const prompter = buildWizardPrompter({ confirm });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        importFrom: "hermes",
        authChoice: "skip",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        workspace: workspaceDir,
      },
      createRuntime(),
      prompter,
    );

    expect(verifySetupInferenceConfig).toHaveBeenCalledOnce();
    expect(verifySetupInferenceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              model: { primary: "openai/gpt-5.6-sol" },
            }),
          }),
        }),
      }),
    );
    expect(confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Test AI access now with a live completion?" }),
    );
  });

  it("keeps verification optional when provider setup supplies the post-import model", async () => {
    const workspaceDir = await makeCaseDir("provider-after-import-");
    readConfigFileSnapshot
      .mockResolvedValueOnce(configSnapshot({}, false))
      .mockResolvedValue(configSnapshot({}));
    applyAuthChoice.mockResolvedValue({
      config: { agents: { defaults: { model: { primary: "openai/gpt-5.6" } } } },
    });
    const confirm = vi.fn(async () => false) as unknown as WizardPrompter["confirm"];
    const prompter = buildWizardPrompter({ confirm });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        importFrom: "claude",
        authChoice: "demo-provider",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        workspace: workspaceDir,
      },
      createRuntime(),
      prompter,
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Test AI access now with a live completion?" }),
    );
    expect(verifySetupInferenceConfig).not.toHaveBeenCalled();
  });

  it("repairs an imported route that fails its mandatory live check", async () => {
    const workspaceDir = await makeCaseDir("repair-import-flow-");
    const importedConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
    };
    readConfigFileSnapshot
      .mockResolvedValueOnce(configSnapshot({}, false))
      .mockResolvedValue(configSnapshot(importedConfig));
    promptAuthChoiceGrouped.mockResolvedValue("demo-provider");
    applyAuthChoice.mockResolvedValue({
      config: { agents: { defaults: { model: { primary: "openai/gpt-5.6" } } } },
    });
    verifySetupInferenceConfig
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "imported login expired" })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "openai/gpt-5.6",
        latencyMs: 250,
      });
    const select = vi.fn() as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        importFrom: "hermes",
        authChoice: "skip",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        workspace: workspaceDir,
      },
      createRuntime(),
      prompter,
    );

    expect(verifySetupInferenceConfig).toHaveBeenCalledTimes(2);
    expect(applyAuthChoice).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "How would you like to continue?" }),
    );
  });

  it("treats --import-source alone as import intent instead of prompting for a setup mode", async () => {
    const workspaceDir = await makeCaseDir("import-source-intent-");
    const prompter = buildWizardPrompter();
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        importSource: "~/.hermes",
        authChoice: "skip",
        installDaemon: false,
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

    expect(runSetupMigrationImport).toHaveBeenCalledOnce();
    expect(runSetupMigrationImport).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ importSource: "~/.hermes" }),
      }),
    );
    expect(prompter.select).not.toHaveBeenCalled();
  });

  it("allows size-drop writes for pending plugin install record migration", async () => {
    replaceConfigFile.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        plugins: {
          installs: {
            demo: { source: "npm", spec: "@openclaw/demo-plugin" },
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });

    const workspaceDir = await makeCaseDir("plugin-install-migration-");
    const select = vi.fn(async ({ options }: WizardSelectParams<unknown>) => {
      const values = options.map((option) => option.value);
      if (values.includes("keep")) {
        return "keep";
      }
      if (values.includes("quickstart")) {
        return "quickstart";
      }
      if (values.includes("__skip__")) {
        return "__skip__";
      }
      return values[0];
    }) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
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

    // Migration write + pre-channels persist + post-channels write + final write.
    expect(replaceConfigFile).toHaveBeenCalledTimes(4);
    const migrationParams = requireRecord(
      getMockCallArg(replaceConfigFile, 0, 0, "migration config replacement"),
      "migration config replacement params",
    );
    expect(
      requireRecord(migrationParams.nextConfig, "migration next config").plugins,
    ).toBeUndefined();
    const migrationWriteOptions = expectRecordFields(
      migrationParams.writeOptions,
      { allowConfigSizeDrop: true },
      "migration config replacement write options",
    );
    expect(migrationWriteOptions.unsetPaths).toContainEqual(["plugins", "installs"]);

    const replaceParams = requireRecord(
      getMockCallArg(replaceConfigFile, 3, 0, "config replacement"),
      "config replacement params",
    );
    expect(requireRecord(replaceParams.nextConfig, "next config").plugins).toBeUndefined();
    expectRecordFields(
      replaceParams.writeOptions,
      { allowConfigSizeDrop: false },
      "config replacement write options",
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
          skipChannels: true,
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

  it("keeps current model auth config when the matching provider keep option is selected", async () => {
    promptAuthChoiceGrouped.mockClear();
    applyAuthChoice.mockClear();
    promptDefaultModel.mockClear();
    replaceConfigFile.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
            },
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    promptAuthChoiceGrouped.mockResolvedValueOnce(keepCurrentAuthChoice);
    const workspaceDir = await makeCaseDir("keep-provider-config-");
    const prompter = buildWizardPrompter();
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
        workspace: workspaceDir,
      },
      runtime,
      prompter,
    );

    expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
    expectRecordFields(
      getMockCallArg(promptAuthChoiceGrouped, 0, 0, "auth choice prompt"),
      {
        includeSkip: true,
        allowKeepCurrentProvider: true,
      },
      "auth choice prompt params",
    );
    expect(applyAuthChoice).not.toHaveBeenCalled();
    expect(promptDefaultModel).not.toHaveBeenCalled();
    const finalCallIndex = replaceConfigFile.mock.calls.length - 1;
    const replaceParams = requireRecord(
      getMockCallArg(replaceConfigFile, finalCallIndex, 0, "final config replacement"),
      "final config replacement params",
    );
    const nextConfig = requireRecord(replaceParams.nextConfig, "next config");
    const agents = requireRecord(nextConfig.agents, "next config agents");
    const defaults = requireRecord(agents.defaults, "next config agent defaults");
    const model = requireRecord(defaults.model, "next config default model");
    expect(model.primary).toBe("openai/gpt-5.5");
  });

  it("moves an existing fleet workspace only after explicit confirmation", async () => {
    const currentWorkspace = await makeCaseDir("current-fleet-workspace-");
    const requestedWorkspace = await makeCaseDir("requested-fleet-workspace-");
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
        agents: {
          defaults: { workspace: currentWorkspace },
          list: [{ id: "main" }, { id: "ops" }],
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    const confirm = vi.fn(async () => true);
    const prompter = buildWizardPrompter({ confirm });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        workspace: requestedWorkspace,
      },
      createRuntime(),
      prompter,
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Move the existing agent fleet"),
        initialValue: false,
      }),
    );
    expect(getWizardNoteCalls(prompter.note).flat().join("\n")).toContain(currentWorkspace);
    const finalConfig = persistedWizardConfigs().at(-1);
    expect(finalConfig?.agents?.defaults?.workspace).toBe(requestedWorkspace);
    expect(ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      requestedWorkspace,
      expect.anything(),
      expect.any(Object),
    );
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

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          mode: "local",
          workspace: workspaceDir,
          authChoice: "skip",
          skipChannels: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          installDaemon: false,
        },
        runtime,
        prompter,
      ),
    ).rejects.toThrow("exit:0");

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
          skipChannels: true,
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

  it("disables back navigation before side-effecting channel setup", async () => {
    setupChannels.mockImplementationOnce(async (cfg, _runtime, channelPrompter) => {
      if (!channelPrompter) {
        throw new Error("expected channel setup prompter");
      }
      await channelPrompter.select({
        message: "Channel side effect",
        options: [{ value: "continue", label: "Continue" }],
      });
      return cfg;
    });
    const select = vi.fn(async () => "continue") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipChannels: false,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(setupChannels).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Channel side effect",
        navigation: { canGoBack: false, canGoForward: false },
      }),
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
              primary: "openai/gpt-5.5",
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
        authChoice: "openai-chatgpt-api-key",
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
    const call = getMockCallArg(applyAuthChoice, 0, 0, "openai auth choice");
    const opts = (call as { opts?: Record<string, unknown> }).opts ?? {};
    expect(opts.openaiApiKey).toBe("sk-flag-value");
  });

  it("passes preserveExistingDefaultModel to applyAuthChoice to protect existing default model", async () => {
    applyAuthChoice.mockReset();
    applyAuthChoice.mockResolvedValueOnce({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-3.1-pro-preview",
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
        authChoice: "google-api-key",
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

    expect(applyAuthChoice).toHaveBeenCalledTimes(1);
    const call = getMockCallArg(applyAuthChoice, 0, 0, "google auth choice");
    // Preserve the user's existing default model when a new provider is
    // configured through the setup wizard, matching the contract already
    // used in configure.gateway-auth.ts. Without this flag, configuring a
    // paid Google Gemini key would silently overwrite the user's default
    // model, causing existing heartbeat turns to consume paid API quota.
    expect((call as { preserveExistingDefaultModel?: boolean }).preserveExistingDefaultModel).toBe(
      true,
    );
  });

  it("shows plugin compatibility notices for an existing valid config", async () => {
    buildPluginCompatibilitySnapshotNotices.mockReturnValue([
      {
        pluginId: "legacy-plugin",
        code: "hook-only",
        compatCode: "hook-only-plugin-shape",
        severity: "info",
        message:
          "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
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
    const select = vi.fn(async () => "quickstart") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ note, select });
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
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

    const calls = getWizardNoteCalls(note);
    const noteTitles = calls.map((call) => call?.[1]);
    expect(noteTitles).toContain("Plugin compatibility");
    expect(noteTitles).toContain("Existing config detected");
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Config handling" }),
    );
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
    const select = vi.fn(async () => "quickstart") as unknown as WizardPrompter["select"];
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
          skipChannels: true,
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
        skipChannels: true,
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

  it("persists explicit classic quickstart gateway options without printing the password", async () => {
    const password = ["classic", "password", "placeholder"].join("-");
    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const prompter = buildWizardPrompter({ note });
    const runtime = createRuntime();
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
        gateway: {
          port: 19111,
          bind: "loopback",
          auth: { mode: "token", token: "stored-token" },
          tailscale: { mode: "off", resetOnExit: false },
        },
      }),
    );
    replaceConfigFile.mockClear();
    configureGatewayForSetup.mockImplementationOnce(async (args) => ({
      nextConfig: {
        ...args.nextConfig,
        gateway: {
          ...args.nextConfig.gateway,
          port: args.quickstartGateway.port,
          bind: args.quickstartGateway.bind,
          auth: {
            ...args.nextConfig.gateway?.auth,
            mode: args.quickstartGateway.authMode,
            password: args.quickstartGateway.password,
          },
          tailscale: {
            ...args.nextConfig.gateway?.tailscale,
            mode: args.quickstartGateway.tailscaleMode,
            resetOnExit: args.quickstartGateway.tailscaleResetOnExit,
          },
        },
      },
      settings: {
        port: args.quickstartGateway.port,
        bind: args.quickstartGateway.bind,
        authMode: args.quickstartGateway.authMode,
        gatewayToken: undefined,
        tailscaleMode: args.quickstartGateway.tailscaleMode,
        tailscaleResetOnExit: args.quickstartGateway.tailscaleResetOnExit,
      },
    }));

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        mode: "local",
        authChoice: "skip",
        gatewayPort: 19001,
        gatewayBind: "lan",
        gatewayAuth: "password",
        gatewayPassword: password,
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

    const gatewaySetup = getMockCallArg(configureGatewayForSetup, 0, 0, "gateway setup");
    expect(requireRecord(gatewaySetup, "gateway setup").quickstartGateway).toMatchObject({
      port: 19001,
      bind: "lan",
      authMode: "password",
      password,
    });
    expect(
      persistedWizardConfigs().some(
        (config) =>
          config.gateway?.port === 19001 &&
          config.gateway.bind === "lan" &&
          config.gateway.auth?.mode === "password" &&
          config.gateway.auth.password === password,
      ),
    ).toBe(true);

    const visibleOutput = [
      ...getWizardNoteCalls(note).flat(),
      ...((runtime.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat() as unknown[]),
      ...((runtime.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat() as unknown[]),
    ].join("\n");
    expect(visibleOutput).toContain("19001");
    expect(visibleOutput).not.toContain("Keeping your current gateway settings:");
    expect(visibleOutput).not.toContain(password);
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
          skipChannels: true,
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
          skipChannels: true,
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
      providerId: "openai",
      methodId: "oauth",
      choiceId: "openai",
      choiceLabel: "ChatGPT/Codex Browser Login",
    });
    resolvePluginSetupProvider.mockReturnValue({
      id: "openai",
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
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai");
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
        provider: "openai",
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

  it("offers a live AI check after classic model setup", async () => {
    applyAuthChoice.mockResolvedValueOnce({
      config: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    });
    const confirm = vi.fn(async () => true) as unknown as WizardPrompter["confirm"];
    const prompter = buildWizardPrompter({ confirm });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "demo-provider",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime(),
      prompter,
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Test AI access now with a live completion?" }),
    );
    expect(verifySetupInferenceConfig).toHaveBeenCalledOnce();
  });

  it("continues classic setup when live AI verification fails", async () => {
    applyAuthChoice.mockResolvedValueOnce({
      config: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    });
    verifySetupInferenceConfig.mockResolvedValueOnce({
      ok: false,
      status: "auth",
      error: "login expired",
    });
    const select = vi.fn(async () => "continue") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => true), select });

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "demo-provider",
          installDaemon: false,
          skipChannels: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        createRuntime(),
        prompter,
      ),
    ).resolves.toBeUndefined();

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "How would you like to continue?" }),
    );
    expect(verifySetupInferenceConfig).toHaveBeenCalledOnce();
  });

  it("keeps failed model/auth fixes in the verification loop without persisting them", async () => {
    const stateDir = await makeCaseDir("failed-auth-profile-retry-");
    const agentDir = path.join(stateDir, "agent");
    prepareMockAuthProfilesIn(agentDir);
    applyAuthChoice
      .mockResolvedValueOnce({
        config: modelConfigWithApiKey("test-original-key"),
      })
      .mockResolvedValueOnce({
        config: modelConfigWithApiKey("test-retry-invalid-key"),
      })
      .mockResolvedValueOnce({
        config: modelConfigWithApiKey("test-retry-still-invalid-key"),
      });
    promptAuthChoiceGrouped.mockResolvedValue("demo-provider");
    verifySetupInferenceConfig
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "login expired" })
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "key rejected" })
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "key still rejected" });
    const select = vi
      .fn()
      .mockResolvedValueOnce("fix")
      .mockResolvedValueOnce("fix")
      .mockResolvedValueOnce("continue") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => true), select });

    try {
      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "demo-provider",
          installDaemon: false,
          skipChannels: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        createRuntime(),
        prompter,
      );

      expect(applyAuthChoice).toHaveBeenCalledTimes(3);
      expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
      expect(verifySetupInferenceConfig).toHaveBeenCalledTimes(3);
      const thirdVerification = getMockCallArg(
        verifySetupInferenceConfig,
        2,
        0,
        "third verification",
      ) as Parameters<VerifySetupInferenceConfig>[0];
      expect(thirdVerification.config.models?.providers?.openai?.apiKey).toBe(
        "test-retry-still-invalid-key",
      );
      const secondRetry = getMockCallArg(
        applyAuthChoice,
        2,
        0,
        "second retry auth choice",
      ) as Parameters<ApplyAuthChoice>[0];
      expect(secondRetry.config.models?.providers?.openai?.apiKey).toBe("test-original-key");
      expect(select).toHaveBeenCalledTimes(3);
      expect(thirdVerification.authProfiles).toEqual([
        stagedOpenAiProfile("test-retry-still-invalid-key"),
      ]);
      expect(
        persistedWizardConfigs().some(
          (config) =>
            config.models?.providers?.openai?.apiKey === "test-retry-invalid-key" ||
            config.models?.providers?.openai?.apiKey === "test-retry-still-invalid-key",
        ),
      ).toBe(false);
      expect(readAuthProfileStoreForTest(agentDir).profiles["openai:default"]).toEqual(
        stagedOpenAiProfile("test-original-key").credential,
      );
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("persists a model/auth fix after its live verification succeeds", async () => {
    const stateDir = await makeCaseDir("successful-auth-profile-retry-");
    const agentDir = path.join(stateDir, "agent");
    const persistCalls = prepareMockAuthProfilesIn(agentDir);
    applyAuthChoice
      .mockResolvedValueOnce({
        config: modelConfigWithApiKey("test-original-key"),
      })
      .mockResolvedValueOnce({
        config: modelConfigWithApiKey("test-retry-valid-key"),
      });
    promptAuthChoiceGrouped.mockResolvedValue("demo-provider");
    verifySetupInferenceConfig
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "login expired" })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 300,
        authProfiles: [stagedOpenAiProfile("test-retry-valid-key")],
      });
    const select = vi.fn(async () => "fix") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => true), select });

    try {
      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "demo-provider",
          installDaemon: false,
          skipChannels: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        createRuntime(),
        prompter,
      );

      expect(applyAuthChoice).toHaveBeenCalledTimes(2);
      expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
      expect(verifySetupInferenceConfig).toHaveBeenCalledTimes(2);
      const retryVerification = getMockCallArg(
        verifySetupInferenceConfig,
        1,
        0,
        "retry verification",
      ) as Parameters<VerifySetupInferenceConfig>[0];
      expect(retryVerification.config.models?.providers?.openai?.apiKey).toBe(
        "test-retry-valid-key",
      );
      expect(retryVerification.authProfiles).toEqual([stagedOpenAiProfile("test-retry-valid-key")]);
      expect(
        persistedWizardConfigs().some(
          (config) => config.models?.providers?.openai?.apiKey === "test-retry-valid-key",
        ),
      ).toBe(true);
      expect(readAuthProfileStoreForTest(agentDir).profiles["openai:default"]).toEqual(
        stagedOpenAiProfile("test-retry-valid-key").credential,
      );
      expect(persistCalls).toEqual([undefined, [stagedOpenAiProfile("test-retry-valid-key")]]);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("retains a staged retry credential when a later Fix keeps the current auth", async () => {
    const stateDir = await makeCaseDir("kept-auth-profile-retry-");
    const agentDir = path.join(stateDir, "agent");
    prepareMockAuthProfilesIn(agentDir);
    applyAuthChoice
      .mockResolvedValueOnce({
        config: modelConfigWithApiKey("test-original-key"),
      })
      .mockResolvedValueOnce({
        config: modelConfigWithApiKey("test-staged-key"),
      });
    promptAuthChoiceGrouped
      .mockResolvedValueOnce("demo-provider")
      .mockResolvedValueOnce(keepCurrentAuthChoice);
    verifySetupInferenceConfig
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "login expired" })
      .mockResolvedValueOnce({
        ok: false,
        status: "timeout",
        error: "request timed out",
        authProfiles: [stagedOpenAiProfile("test-refreshed-key")],
      })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 300,
      });
    const select = vi.fn(async () => "fix") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => true), select });

    try {
      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "demo-provider",
          installDaemon: false,
          skipChannels: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        createRuntime(),
        prompter,
      );

      expect(applyAuthChoice).toHaveBeenCalledTimes(2);
      expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
      expect(verifySetupInferenceConfig).toHaveBeenCalledTimes(3);
      const finalVerification = getMockCallArg(
        verifySetupInferenceConfig,
        2,
        0,
        "final verification",
      ) as Parameters<VerifySetupInferenceConfig>[0];
      expect(finalVerification.authProfiles).toEqual([stagedOpenAiProfile("test-refreshed-key")]);
      expect(readAuthProfileStoreForTest(agentDir).profiles["openai:default"]).toEqual(
        stagedOpenAiProfile("test-staged-key").credential,
      );
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
