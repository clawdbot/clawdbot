import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
// Setup wizard tests cover end-to-end onboarding prompt flows.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
} from "../agents/auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import { ConfigMutationConflictError } from "../config/config.js";
import { createConfigIO as createRealConfigIO } from "../config/io.factory.js";
import { coerceConfig } from "../config/io.read-helpers.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import { materializeRuntimeConfig } from "../config/materialize.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError, type WizardPrompter, type WizardSelectParams } from "./prompts.js";
import { runSetupWizard } from "./setup.js";
import {
  SetupMigrationFreshnessError,
  SetupMigrationTargetChangedError,
} from "./setup.migration-snapshot.js";

type ResolveProviderPluginChoice =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolveProviderPluginChoice;
type ResolvePluginProvidersRuntime =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginProviders;
type ResolvePluginSetupProvider =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginSetupProvider;
type ResolveManifestProviderAuthChoice =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoice;
type ResolveProviderOnboardAuthFlags =
  typeof import("../plugins/provider-auth-choices.js").resolveProviderOnboardAuthFlags;
type PromptDefaultModel = typeof import("../commands/model-picker.js").promptDefaultModel;
type ApplyAuthChoice = typeof import("../commands/auth-choice.js").applyAuthChoice;
type PrepareAuthChoice = typeof import("../commands/auth-choice.js").prepareAuthChoice;
type VerifySetupInferenceConfig =
  typeof import("../system-agent/setup-inference.js").verifySetupInferenceConfig;
type ConfigureGatewayForSetup = typeof import("./setup.gateway-config.js").configureGatewayForSetup;
type ListSetupMigrationOptions =
  typeof import("./setup.migration-import.js").listSetupMigrationOptions;
type RunSetupMigrationImport = typeof import("./setup.migration-import.js").runSetupMigrationImport;
type RunSearchSetupFlow = typeof import("../flows/search-setup.js").runSearchSetupFlow;

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));
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
const resolveProviderOnboardAuthFlags = vi.hoisted(() =>
  vi.fn<ResolveProviderOnboardAuthFlags>(() => []),
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
const listSetupMigrationOptions = vi.hoisted(() =>
  vi.fn<ListSetupMigrationOptions>(async () => []),
);
const runSetupMigrationImport = vi.hoisted(() =>
  vi.fn<RunSetupMigrationImport>(async () => ({ kind: "no-imported-inference" })),
);
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
const runSearchSetupFlow = vi.hoisted(() =>
  vi.fn<RunSearchSetupFlow>(async (config) => ({ outcome: "completed", config })),
);
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
const ensureOnboardingConfig = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
    config,
    agentId: "main",
    bootstrapPending: true,
  })),
);
const replaceConfigFile = vi.hoisted(() =>
  vi.fn(
    async (params: {
      nextConfig: OpenClawConfig;
      snapshot?: { hash?: string };
      baseHash?: string;
    }) => ({ config: params.nextConfig }),
  ),
);
const resolveGatewayPort = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, env?: NodeJS.ProcessEnv) => {
    const raw = env?.OPENCLAW_GATEWAY_PORT ?? process.env.OPENCLAW_GATEWAY_PORT;
    const port = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(port) && port > 0 ? port : 18789;
  }),
);
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn<typeof import("../config/io.js").readConfigFileSnapshot>(),
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
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      entries: { main: { default: true } },
    },
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

const requireRecord = createRequireRecord("record", "expected-label-object");

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

vi.mock("../commands/onboard-channels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-channels.js")>()),
  setupChannels,
}));

vi.mock("../commands/onboard-skills.js", () => ({
  setupSkills,
}));

vi.mock("../flows/search-setup.js", () => ({
  runSearchSetupFlow,
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
  isKeepCurrentAuthChoice: (value: unknown) => value === "__keep-current",
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
  resolveManifestProviderAuthChoices: () => [],
  resolveProviderOnboardAuthFlags,
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: resolvePluginSetupProvider,
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
  healthCommandNonExiting: healthCommand,
}));

vi.mock("../commands/onboard-hooks.js", async (importActual) => ({
  ...(await importActual<typeof import("../commands/onboard-hooks.js")>()),
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

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    DEFAULT_GATEWAY_PORT: 18789,
    ConfigMutationConflictError: actual.ConfigMutationConflictError,
    createConfigIO,
    readConfigFileSnapshot,
    resolveConfigWriteAfterWrite: actual.resolveConfigWriteAfterWrite,
    resolveGatewayPort,
    replaceConfigFile,
    transformConfigFileWithRetry: async (params: {
      base?: "runtime" | "source";
      maxAttempts?: number;
      writeOptions?: Record<string, unknown>;
      transform: (
        config: OpenClawConfig,
        context: {
          snapshot: Record<string, unknown>;
          previousHash: string | null;
          attempt: number;
        },
      ) => Promise<{ nextConfig: OpenClawConfig }> | { nextConfig: OpenClawConfig };
      commit: (params: Record<string, unknown>) => Promise<{ config: OpenClawConfig }>;
    }) => {
      const maxAttempts = params.maxAttempts ?? 5;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const snapshot = await readConfigFileSnapshot();
        const previousHash = snapshot.hash ?? null;
        const config = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
        try {
          const transformed = await params.transform(config, { snapshot, previousHash, attempt });
          const committed = await params.commit({
            nextConfig: transformed.nextConfig,
            snapshot,
            ...(previousHash ? { baseHash: previousHash } : {}),
            writeOptions: params.writeOptions,
            afterWrite: { mode: "auto" },
          });
          return { nextConfig: committed.config };
        } catch (error) {
          if (
            !(error instanceof actual.ConfigMutationConflictError) ||
            !error.retryable ||
            attempt === maxAttempts - 1
          ) {
            throw error;
          }
        }
      }
      throw new Error("unreachable");
    },
  };
});
vi.mock("../commands/onboard-agent.js", async () => {
  return {
    ensureOnboardingAgent: ensureOnboardingConfig,
    validateFirstOnboardingAgentName: (value: string | undefined) =>
      value?.trim() ? undefined : "Agent name is required.",
  };
});
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
  CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS: 600_000,
  ensureControlUiAssetsBuilt,
  isControlUiStartupAssetsReady: vi.fn(() => true),
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

const defaultSetupOptions = {
  acceptRisk: true,
  flow: "quickstart",
  authChoice: "skip",
  installDaemon: false,
  skipChannels: true,
  skipSkills: true,
  skipSearch: true,
  skipHealth: true,
  skipUi: true,
} satisfies Parameters<typeof runSetupWizard>[0];

async function runWizard(
  options: Parameters<typeof runSetupWizard>[0] = {},
  runtime = createRuntime(),
  prompter = buildWizardPrompter(),
) {
  await runSetupWizard({ ...defaultSetupOptions, ...options }, runtime, prompter);
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

  function configSnapshot(config: OpenClawConfig, exists = true): ConfigFileSnapshot {
    const sourceConfig = coerceConfig(migratePersistedImplicitMainRoster(config).config);
    return createConfigFileSnapshot({
      path: "/tmp/.openclaw/openclaw.json",
      exists,
      raw: exists ? JSON.stringify(config) : null,
      parsed: exists ? config : {},
      sourceConfigBeforeMigrations: exists ? config : undefined,
      sourceConfig,
      valid: true,
      runtimeConfig: materializeRuntimeConfig(sourceConfig, { manifestRegistry: { plugins: [] } }),
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
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
    runSearchSetupFlow.mockReset();
    runSearchSetupFlow.mockImplementation(async (config: OpenClawConfig) => ({
      outcome: "completed",
      config,
    }));
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
      },
    }));
    let authoredConfig: OpenClawConfig | undefined;
    readConfigFileSnapshot.mockReset();
    readConfigFileSnapshot.mockImplementation(async () =>
      configSnapshot(authoredConfig ?? {}, authoredConfig !== undefined),
    );
    replaceConfigFile.mockReset();
    replaceConfigFile.mockImplementation(async (params) => {
      authoredConfig = structuredClone(params.nextConfig);
      return { config: params.nextConfig };
    });
    probeGatewayReachable.mockReset();
    probeGatewayReachable.mockResolvedValue({ ok: false });
    resolvePreferredProviderForAuthChoice.mockReset();
    resolvePreferredProviderForAuthChoice.mockResolvedValue("demo-provider");
    resolvePluginProvidersRuntime.mockReset();
    resolvePluginProvidersRuntime.mockReturnValue([]);
    resolveManifestProviderAuthChoice.mockReset();
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolveProviderOnboardAuthFlags.mockReset();
    resolveProviderOnboardAuthFlags.mockReturnValue([]);
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
    runSetupMigrationImport.mockReset();
    runSetupMigrationImport.mockResolvedValue({ kind: "no-imported-inference" });
    verifySetupInferenceConfig.mockReset();
    verifySetupInferenceConfig.mockResolvedValue({
      ok: true,
      modelRef: "openai/gpt-5.5",
      latencyMs: 250,
    });
    runSetupMemoryImportStep.mockReset();
    runSetupMemoryImportStep.mockResolvedValue(undefined);
    ensureOnboardingConfig.mockClear();
  });

  it("prompts for and stages the named first agent on a fresh install", async () => {
    const prompter = buildWizardPrompter({ text: vi.fn(async () => "robby") });
    ensureOnboardingConfig.mockImplementationOnce(async ({ config }) => ({
      config,
      agentId: "robby",
      bootstrapPending: true,
      createdAgent: true,
      sessionMigrationWarnings: ["Run `openclaw doctor --fix` and retry setup."],
    }));

    await runWizard({ workspace: "/tmp/openclaw-workspace" }, createRuntime(), prompter);

    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "What should we call your first agent?",
        initialValue: "main",
      }),
    );
    expect(ensureOnboardingConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/tmp/openclaw-workspace",
        preserveCandidateRoster: false,
        firstAgent: { name: "robby" },
      }),
    );
    expect(prompter.note).toHaveBeenCalledWith(
      "Run `openclaw doctor --fix` and retry setup.",
      "Session history migration",
    );
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
    readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot({}));
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
    const config = coerceConfig({ routing: { allowFrom: ["*"] } });
    readConfigFileSnapshot.mockResolvedValueOnce({
      ...configSnapshot(config),
      valid: false,
      issues: [{ path: "routing.allowFrom", message: "Legacy key" }],
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
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Help make OpenClaw better?", initialValue: false }),
    );
    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(setupChannels).not.toHaveBeenCalled();
    expect(setupSkills).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
  });

  it("preserves an unrelated config edit made during classic onboarding", async () => {
    const initialConfig: OpenClawConfig = { ui: { seamColor: "blue" } };
    let diskConfig = structuredClone(initialConfig);
    let diskHash = "hash-1";
    const snapshotFromDisk = () => ({
      ...configSnapshot(diskConfig),
      hash: diskHash,
    });
    readConfigFileSnapshot.mockImplementation(async () => snapshotFromDisk());
    replaceConfigFile.mockImplementation(async (params) => {
      expect(params.snapshot?.hash).toBe(diskHash);
      expect(params.baseHash).toBe(diskHash);
      diskConfig = structuredClone(params.nextConfig);
      diskHash = `hash-${Number(diskHash.slice(5)) + 1}`;
      return { config: diskConfig };
    });
    setupChannels.mockImplementationOnce(async (config) => {
      diskConfig = {
        ...diskConfig,
        ui: { ...diskConfig.ui, seamColor: "green" },
      };
      diskHash = "external-edit";
      return config;
    });

    await runWizard({
      skipChannels: false,
      workspace: "/tmp/concurrent-onboarding-workspace",
    });

    expect(diskConfig.ui?.seamColor).toBe("green");
    expect(diskConfig.agents?.defaults?.workspace).toBe("/tmp/concurrent-onboarding-workspace");
    expect(diskConfig.hooks?.internal?.entries?.["session-memory"]?.enabled).toBe(true);
  });

  it("re-reads and merges the latest config after a write conflict", async () => {
    let diskConfig: OpenClawConfig = { ui: { seamColor: "blue" } };
    let diskHash = "hash-1";
    let writeAttempts = 0;
    readConfigFileSnapshot.mockImplementation(async () => ({
      ...configSnapshot(diskConfig),
      hash: diskHash,
    }));
    replaceConfigFile.mockImplementation(async (params) => {
      expect(params.snapshot?.hash).toBe(diskHash);
      expect(params.baseHash).toBe(diskHash);
      writeAttempts += 1;
      if (writeAttempts === 1) {
        diskConfig = { ...diskConfig, ui: { ...diskConfig.ui, seamColor: "green" } };
        diskHash = "external-edit";
        throw new ConfigMutationConflictError("config changed since last load");
      }
      diskConfig = structuredClone(params.nextConfig);
      diskHash = `committed-${writeAttempts}`;
      return { config: diskConfig, persistedHash: diskHash };
    });

    await runWizard({ workspace: "/tmp/conflicting-onboarding-workspace" });

    expect(writeAttempts).toBe(4);
    expect(diskConfig.ui?.seamColor).toBe("green");
    expect(diskConfig.agents?.defaults?.workspace).toBe("/tmp/conflicting-onboarding-workspace");
  });

  it.each([
    { name: "token", optionKey: "remoteToken", remoteKey: "token", hasStoredUrl: true },
    { name: "password", optionKey: "remotePassword", remoteKey: "password", hasStoredUrl: true },
    {
      name: "token without a saved endpoint",
      optionKey: "remoteToken",
      remoteKey: "token",
      hasStoredUrl: false,
    },
  ])(
    "seeds interactive remote $name auth from command flags",
    async ({ optionKey, remoteKey, hasStoredUrl }) => {
      const storedUrl = hasStoredUrl ? "wss://stored.example.com:18789" : undefined;
      const remoteCredential = "REDACTED";
      readConfigFileSnapshot.mockResolvedValueOnce(
        configSnapshot({
          gateway: {
            remote: {
              url: storedUrl,
              token: { source: "env", provider: "default", id: "STORED_GATEWAY_TOKEN" },
              password: { source: "env", provider: "default", id: "STORED_GATEWAY_PASSWORD" },
            },
          },
        }),
      );
      const prompter = buildWizardPrompter({});
      const runtime = createRuntime();

      if (remoteKey === "password") {
        vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "ambient-gateway-token");
      }
      try {
        await runSetupWizard(
          {
            acceptRisk: true,
            flow: "advanced",
            mode: "remote",
            remoteUrl: " wss://flag.example.com:18789 ",
            [optionKey]: ` ${remoteCredential} `,
          },
          runtime,
          prompter,
        );
      } finally {
        if (remoteKey === "password") {
          vi.unstubAllEnvs();
        }
      }

      expect(probeGatewayReachable).toHaveBeenCalledWith({
        originScopedDeviceAuth: true,
        url: "wss://flag.example.com:18789",
        config: expect.any(Object),
        token: remoteKey === "token" ? remoteCredential : undefined,
        ...(remoteKey === "password" ? { password: remoteCredential } : {}),
      });
      expect(promptRemoteGatewayConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          gateway: expect.objectContaining({
            remote: {
              url: "wss://flag.example.com:18789",
              token: remoteKey === "token" ? remoteCredential : undefined,
              password: remoteKey === "password" ? remoteCredential : undefined,
            },
          }),
        }),
        expect.any(Object),
        expect.any(Object),
      );
      expect(
        getMockCallArg(promptRemoteGatewayConfig, 0, 2, "remote prompt options"),
      ).toStrictEqual({
        secretInputMode: undefined,
        remoteOriginUrl: storedUrl,
      });
      expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining(remoteCredential));
    },
  );

  it("uses the configured remote password for the setup reachability probe", async () => {
    const remotePassword = "remote-password"; // pragma: allowlist secret
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example.test",
            password: remotePassword,
          },
        },
      }),
    );

    await runSetupWizard(
      { acceptRisk: true, flow: "advanced", mode: "remote" },
      createRuntime(),
      buildWizardPrompter({}),
    );

    expect(probeGatewayReachable).toHaveBeenCalledWith({
      originScopedDeviceAuth: true,
      url: "wss://gateway.example.test",
      config: expect.any(Object),
      token: undefined,
      password: remotePassword,
    });
  });

  it.each([{ edgeAuth: { "X-Edge-Auth": "test-secret" } }, { tlsFingerprint: "ab".repeat(32) }])(
    "passes remote trust settings to the setup reachability probe: %j",
    async (trust) => {
      const config: OpenClawConfig = {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example.test",
            ...trust,
          },
        },
      };
      readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot(config));

      await runSetupWizard(
        { acceptRisk: true, flow: "advanced", mode: "remote" },
        createRuntime(),
        buildWizardPrompter({}),
      );

      expect(probeGatewayReachable).toHaveBeenCalledWith({
        originScopedDeviceAuth: true,
        url: "wss://gateway.example.test",
        config: expect.objectContaining({
          gateway: config.gateway,
        }),
        token: undefined,
      });
    },
  );

  it("keeps a configured remote token authoritative over an environment password", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example.test",
            token: { source: "env", provider: "default", id: "REMOTE_SECRET_TOKEN" },
          },
        },
        secrets: { providers: { default: { source: "env" } } },
      }),
    );
    vi.stubEnv("REMOTE_SECRET_TOKEN", "resolved-remote-token");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "env-password"); // pragma: allowlist secret

    try {
      await runSetupWizard(
        { acceptRisk: true, flow: "advanced", mode: "remote" },
        createRuntime(),
        buildWizardPrompter({}),
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(probeGatewayReachable).toHaveBeenCalledWith({
      originScopedDeviceAuth: true,
      url: "wss://gateway.example.test",
      config: expect.any(Object),
      token: "resolved-remote-token",
    });
  });

  it("uses an ambient gateway token as the shared remote fallback", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example.test",
          },
        },
      }),
    );
    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "ambient-token"; // pragma: allowlist secret

    try {
      await runSetupWizard(
        { acceptRisk: true, flow: "advanced", mode: "remote" },
        createRuntime(),
        buildWizardPrompter({}),
      );
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    }

    expect(probeGatewayReachable).toHaveBeenCalledWith({
      originScopedDeviceAuth: true,
      url: "wss://gateway.example.test",
      config: expect.any(Object),
      token: "ambient-token",
    });
  });

  it("does not reuse stored remote credentials for an overridden URL", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
        gateway: {
          remote: {
            url: "wss://stored.example.com:18789",
            token: { source: "env", provider: "default", id: "STORED_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "STORED_GATEWAY_PASSWORD" },
            edgeAuth: { "X-Edge-Auth": "test-secret" },
            tlsFingerprint: "ab".repeat(32),
          },
        },
      }),
    );
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "ambient-password"); // pragma: allowlist secret

    try {
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
    } finally {
      vi.unstubAllEnvs();
    }

    expect(probeGatewayReachable).toHaveBeenCalledWith({
      originScopedDeviceAuth: true,
      url: "wss://flag.example.com:18789",
      config: expect.objectContaining({
        gateway: expect.objectContaining({
          remote: expect.objectContaining({
            url: "wss://stored.example.com:18789",
            edgeAuth: { "X-Edge-Auth": "test-secret" },
            tlsFingerprint: "ab".repeat(32),
          }),
        }),
      }),
      token: undefined,
    });
    expect(promptRemoteGatewayConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({
          remote: {
            url: "wss://flag.example.com:18789",
            token: undefined,
            password: undefined,
            edgeAuth: { "X-Edge-Auth": "test-secret" },
            tlsFingerprint: "ab".repeat(32),
          },
        }),
      }),
      expect.any(Object),
      {
        secretInputMode: undefined,
        remoteOriginUrl: "wss://stored.example.com:18789",
      },
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
    expect(probeGatewayReachable).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://public.example" }),
    );
  });

  it("auto-enables the bundled session-memory hook without showing the hooks screen", async () => {
    replaceConfigFile.mockClear();
    setupInternalHooks.mockClear();
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime({ throwsOnExit: true });

    await runWizard({}, runtime, prompter);

    expect(setupInternalHooks).not.toHaveBeenCalled();
    expect(persistedWizardConfigs().at(-1)?.hooks?.internal?.entries?.["session-memory"]).toEqual({
      enabled: true,
    });
  });

  it("does not auto-enable default hooks when skipHooks is set", async () => {
    replaceConfigFile.mockClear();
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime({ throwsOnExit: true });

    await runWizard({ skipHooks: true }, runtime, prompter);

    expect(persistedWizardConfigs().at(-1)?.hooks).toBeUndefined();
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
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
        wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
      }),
    );
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

  it("leaves feature-stat telemetry unset during non-interactive wizard setup", async () => {
    const prompter = buildWizardPrompter();

    await runWizard({ nonInteractive: true }, createRuntime({ throwsOnExit: true }), prompter);

    expect(persistedWizardConfigs().at(-1)?.telemetry).toBeUndefined();
    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Help make OpenClaw better?" }),
    );
  });

  it("persists skipBootstrap and skips workspace bootstrap creation when requested", async () => {
    ensureWorkspaceAndSessions.mockClear();
    replaceConfigFile.mockClear();

    const workspaceDir = await makeCaseDir("skip-bootstrap-");
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runWizard({ skipBootstrap: true, workspace: workspaceDir }, runtime, prompter);

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

    await runWizard({ workspace: workspaceDir }, runtime, prompter);

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

    await runWizard({ importFrom: "hermes", workspace: workspaceDir }, runtime, prompter);

    expect(runSetupMigrationImport).toHaveBeenCalledOnce();
    expect(runSetupMemoryImportStep).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "freshness rejection",
      error: new SetupMigrationFreshnessError(
        "Migration import during onboarding requires a fresh OpenClaw setup.\nExisting setup:\n- state agents/ exists",
      ),
      detail: "state agents/ exists",
    },
    {
      label: "target change",
      error: new SetupMigrationTargetChangedError(
        "Migration target changed before promotion. Review it and retry.",
      ),
      detail: "Migration target changed before promotion",
    },
  ])("returns to setup mode after an interactive import $label", async ({ error, detail }) => {
    const workspaceDir = await makeCaseDir("import-retry-");
    listSetupMigrationOptions.mockResolvedValueOnce([
      { providerId: "hermes", label: "Import from Hermes" },
    ]);
    runSetupMigrationImport.mockRejectedValueOnce(error);
    const setupChoices: Array<"import" | "quickstart"> = ["import", "quickstart"];
    const select = vi.fn(async (params: WizardSelectParams<unknown>) => {
      if (params.message === "Setup mode") {
        expect(params.options).toEqual([
          expect.objectContaining({ value: "quickstart", label: "QuickStart (recommended)" }),
          expect.objectContaining({ value: "advanced", label: "Manual setup" }),
          expect.objectContaining({ value: "import", label: "Import from another agent" }),
        ]);
        return setupChoices.shift();
      }
      return "__skip__";
    });
    const prompter = buildWizardPrompter({ select: select as unknown as WizardPrompter["select"] });

    await runSetupWizard(
      {
        acceptRisk: true,
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

    expect(select.mock.calls.filter(([params]) => params.message === "Setup mode")).toHaveLength(2);
    expect(runSetupMigrationImport).toHaveBeenCalledOnce();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(detail),
      "Existing config detected",
    );
    expect(finalizeSetupWizard).toHaveBeenCalledOnce();
  });

  it("returns from the migration picker without restarting setup", async () => {
    const workspaceDir = await makeCaseDir("import-back-");
    listSetupMigrationOptions.mockResolvedValueOnce([
      { providerId: "hermes", label: "Import from Hermes" },
    ]);
    runSetupMigrationImport.mockResolvedValueOnce({ kind: "back" });
    const setupChoices: Array<"import" | "quickstart"> = ["import", "quickstart"];
    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) =>
      message === "Setup mode" ? setupChoices.shift() : "__skip__",
    );

    await runSetupWizard(
      {
        acceptRisk: true,
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
      buildWizardPrompter({ select: select as unknown as WizardPrompter["select"] }),
    );

    expect(select.mock.calls.filter(([params]) => params.message === "Setup mode")).toHaveLength(2);
    expect(detectSetupMigrationSources).toHaveBeenCalledOnce();
    expect(runSetupMigrationImport).toHaveBeenCalledOnce();
    expect(finalizeSetupWizard).toHaveBeenCalledOnce();
  });

  it("continues onboarding after a recovered promotion", async () => {
    const workspaceDir = await makeCaseDir("resumed-import-flow-");
    const acknowledgePromotion = vi.fn(async () => {});
    runSetupMigrationImport.mockResolvedValueOnce({
      kind: "no-imported-inference",
      acknowledgePromotion,
    });

    await runWizard({ importFrom: "hermes", workspace: workspaceDir });

    expect(finalizeSetupWizard).toHaveBeenCalledOnce();
    expect(acknowledgePromotion).toHaveBeenCalledOnce();
  });

  it.each(
    [
      { label: "absent roster", agents: {}, authored: false, include: false },
      { label: "empty keyed roster", agents: { entries: {} }, authored: false, include: false },
      { label: "empty legacy roster", agents: { list: [] }, authored: false, include: false },
      {
        label: "authored bare main",
        agents: { entries: { main: {} } },
        authored: true,
        include: false,
      },
      {
        label: "include-owned bare main",
        agents: { entries: { main: {} } },
        authored: true,
        include: true,
      },
      {
        label: "authored named roster",
        agents: { entries: { imported: { name: "Imported" } } },
        authored: true,
        include: false,
      },
    ].flatMap((testCase) => [
      { ...testCase, requestedName: "robby" },
      { ...testCase, requestedName: undefined },
    ]),
  )(
    "uses authored membership for same-command import and naming: $label, name=$requestedName",
    async ({ agents, authored, include, requestedName }) => {
      const workspaceDir = await fs.realpath(await makeCaseDir("import-naming-"));
      const configPath = path.join(workspaceDir, "openclaw.json");
      if (include) {
        await fs.writeFile(path.join(workspaceDir, "roster.json"), JSON.stringify({ agents }));
      }
      await fs.writeFile(
        configPath,
        JSON.stringify({
          ...(include ? { $include: "./roster.json" } : {}),
          agents: { ...(!include ? agents : {}), defaults: { workspace: workspaceDir } },
        }),
      );
      const importedSnapshot = await createRealConfigIO({
        configPath,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      expect(importedSnapshot.valid).toBe(true);
      expect(importedSnapshot.sourceConfigBeforeMigrations?.agents).toEqual({
        ...agents,
        defaults: { workspace: workspaceDir },
      });
      expect(importedSnapshot.sourceConfig?.agents?.entries).toEqual(
        "entries" in agents && Object.keys(agents.entries ?? {}).length
          ? agents.entries
          : { main: {} },
      );
      expect(importedSnapshot.agentRosterIncludeOwned).toBe(include);
      readConfigFileSnapshot
        .mockResolvedValueOnce(configSnapshot({}, false))
        .mockResolvedValue(importedSnapshot);
      const runtime = createRuntime();
      const prompter = buildWizardPrompter({ text: vi.fn(async () => "robby") });

      await runWizard(
        { importFrom: "hermes", agentName: requestedName, workspace: workspaceDir },
        runtime,
        prompter,
      );

      expect(runSetupMigrationImport).toHaveBeenCalledOnce();
      if (authored && requestedName) {
        expect(runtime.error).toHaveBeenCalledWith(
          "--agent-name cannot be combined with an import that supplies an agent roster. Remove --agent-name or choose an import without agents.",
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(ensureOnboardingConfig).not.toHaveBeenCalled();
      } else {
        expect(runtime.error).not.toHaveBeenCalled();
        expect(ensureOnboardingConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            ...(authored ? {} : { firstAgent: { name: "robby" } }),
            workspace: workspaceDir,
            preserveCandidateRoster: authored,
          }),
        );
        expect(finalizeSetupWizard).toHaveBeenCalledOnce();
      }
      const namePrompt = expect.objectContaining({
        message: "What should we call your first agent?",
      });
      if (!authored && !requestedName) {
        expect(prompter.text).toHaveBeenCalledWith(namePrompt);
      } else {
        expect(prompter.text).not.toHaveBeenCalledWith(namePrompt);
      }
    },
  );

  it("consumes a verified imported model without testing it twice", async () => {
    const workspaceDir = await makeCaseDir("verified-import-flow-");
    runSetupMigrationImport.mockResolvedValueOnce({
      kind: "verified-inference",
      modelRef: "openai/gpt-5.6-sol",
    });
    const importedConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-sol" } },
        entries: { main: { default: true } },
      },
    };
    readConfigFileSnapshot
      .mockResolvedValueOnce(configSnapshot({}, false))
      .mockResolvedValue(configSnapshot(importedConfig));
    const confirm = vi.fn(async () => true) as unknown as WizardPrompter["confirm"];
    const prompter = buildWizardPrompter({ confirm });

    await runWizard({ importFrom: "hermes", workspace: workspaceDir }, createRuntime(), prompter);

    expect(verifySetupInferenceConfig).not.toHaveBeenCalled();
    expect(applyAuthChoice).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Test AI access now with a live completion?" }),
    );
  });

  it("does not reuse verification when the recovered model changed", async () => {
    const workspaceDir = await makeCaseDir("changed-verified-import-flow-");
    runSetupMigrationImport.mockResolvedValueOnce({
      kind: "verified-inference",
      modelRef: "openai/gpt-5.6-sol",
    });
    const importedConfig = {
      agents: {
        defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
        entries: { main: { default: true } },
      },
    };
    readConfigFileSnapshot
      .mockResolvedValueOnce(configSnapshot({}, false))
      .mockResolvedValue(configSnapshot(importedConfig));

    await runWizard({
      importFrom: "hermes",
      authChoice: "demo-provider",
      workspace: workspaceDir,
    });

    expect(applyAuthChoice).toHaveBeenCalledOnce();
  });

  it("keeps verification optional when provider setup supplies the post-import model", async () => {
    const workspaceDir = await makeCaseDir("provider-after-import-");
    readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot({}, false));
    applyAuthChoice.mockImplementation(async (args) => ({
      config: {
        ...args.config,
        agents: {
          ...args.config.agents,
          defaults: {
            ...args.config.agents?.defaults,
            model: { primary: "openai/gpt-5.6" },
          },
        },
      },
    }));
    const confirm = vi.fn(async () => false) as unknown as WizardPrompter["confirm"];
    const prompter = buildWizardPrompter({ confirm });

    await runWizard(
      { importFrom: "claude", authChoice: "demo-provider", workspace: workspaceDir },
      createRuntime(),
      prompter,
    );

    expect(applyAuthChoice).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Test AI access now with a live completion?" }),
    );
    expect(verifySetupInferenceConfig).not.toHaveBeenCalled();
    expect(persistedWizardConfigs().at(-1)?.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.6",
    });
  });

  it("preserves imported fleet workspace ownership until the user confirms a move", async () => {
    const currentWorkspace = await makeCaseDir("imported-fleet-current-");
    const requestedWorkspace = await makeCaseDir("imported-fleet-requested-");
    const importedConfig: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: currentWorkspace, systemAgent: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
    };
    readConfigFileSnapshot
      .mockResolvedValueOnce(configSnapshot({}, false))
      .mockResolvedValue(configSnapshot(importedConfig));
    const confirm = vi.fn(async () => false) as unknown as WizardPrompter["confirm"];

    await runWizard(
      { importFrom: "hermes", workspace: requestedWorkspace },
      createRuntime(),
      buildWizardPrompter({ confirm }),
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Move the existing agent fleet"),
        initialValue: false,
      }),
    );
    const persistedAgents = persistedWizardConfigs().at(-1)?.agents;
    expect(persistedAgents?.defaults?.workspace).toBe(currentWorkspace);
    expect(persistedAgents?.entries).toEqual(importedConfig.agents?.entries);
    expect(persistedAgents?.defaults?.systemAgent).toEqual({ agentId: "main" });
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
    expect(prompter.select).toHaveBeenCalledOnce();
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Help make OpenClaw better?", initialValue: false }),
    );
  });

  it("preserves concurrent edits while migrating pending plugin install records", async () => {
    let diskConfig: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
      plugins: {
        installs: {
          demo: { source: "npm", spec: "@openclaw/demo-plugin" },
        },
      },
    };
    let diskHash = "pending-1";
    let snapshotReads = 0;
    let writeAttempts = 0;
    readConfigFileSnapshot.mockImplementation(async () => {
      snapshotReads += 1;
      if (snapshotReads === 2) {
        diskConfig = { ...diskConfig, ui: { seamColor: "red" } };
        diskHash = "external-before-migration";
      }
      return {
        ...configSnapshot(diskConfig),
        hash: diskHash,
      };
    });
    replaceConfigFile.mockImplementation(async (params) => {
      expect(params.snapshot?.hash ?? params.baseHash).toBe(diskHash);
      writeAttempts += 1;
      if (writeAttempts === 2) {
        diskConfig = { ...diskConfig, ui: { seamColor: "green" } };
        diskHash = "external-pending-edit";
        throw new ConfigMutationConflictError("config changed since last load");
      }
      diskConfig = structuredClone(params.nextConfig);
      diskHash = `pending-${writeAttempts + 1}`;
      return { config: diskConfig, persistedHash: diskHash };
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

    await runWizard({ skipBootstrap: true, workspace: workspaceDir }, runtime, prompter);

    // Initial commit (including migration) + conflicted persist + retry + final write.
    expect(replaceConfigFile).toHaveBeenCalledTimes(4);
    const migrationParams = requireRecord(
      getMockCallArg(replaceConfigFile, 0, 0, "migration config replacement"),
      "migration config replacement params",
    );
    expect(
      requireRecord(migrationParams.nextConfig, "migration next config").plugins,
    ).toBeUndefined();
    expect(requireRecord(migrationParams.nextConfig, "migration next config").ui).toEqual({
      seamColor: "red",
    });
    const migrationWriteOptions = expectRecordFields(
      migrationParams.writeOptions,
      { allowConfigSizeDrop: false },
      "migration config replacement write options",
    );
    expect(migrationWriteOptions.unsetPaths).toContainEqual(["plugins", "installs"]);

    const replaceParams = requireRecord(
      getMockCallArg(replaceConfigFile, 3, 0, "config replacement"),
      "config replacement params",
    );
    expect(requireRecord(replaceParams.nextConfig, "next config").plugins).toBeUndefined();
    expect(requireRecord(replaceParams.nextConfig, "next config").ui).toEqual({
      seamColor: "green",
    });
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
    readConfigFileSnapshot.mockResolvedValue(
      configSnapshot({
        wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
            },
          },
        },
      }),
    );
    promptAuthChoiceGrouped.mockResolvedValueOnce("__keep-current");
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
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
        wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
        agents: {
          defaults: { workspace: currentWorkspace },
          list: [{ id: "main", default: true }, { id: "ops" }],
        },
      }),
    );
    const confirm = vi.fn(async () => true);
    const prompter = buildWizardPrompter({ confirm });

    await runWizard({ workspace: requestedWorkspace }, createRuntime(), prompter);

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

      await runWizard({}, runtime, prompter);

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

  it("continues onboarding when search-provider installation fails", async () => {
    const config: OpenClawConfig = { agents: { defaults: { workspace: "/tmp/workspace" } } };
    runSearchSetupFlow.mockResolvedValueOnce({
      outcome: "install-failed",
      config,
      providerId: "brave",
      reason: "failed",
    });
    readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot(config));
    const prompter = buildWizardPrompter({});

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipChannels: true,
          skipSkills: true,
          skipHealth: true,
          skipUi: true,
        },
        createRuntime(),
        prompter,
      ),
    ).resolves.toBeUndefined();

    expect(runSearchSetupFlow).toHaveBeenCalledOnce();
    expect(finalizeSetupWizard).toHaveBeenCalledOnce();
  });

  it("defers channel setup plugin loads during QuickStart until a channel is selected", async () => {
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runWizard({ skipChannels: false }, runtime, prompter);

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

  it("persists classic channel setup before hooks and Gateway finalization", async () => {
    const beforeConfig = { agents: { defaults: { workspace: "/tmp/workspace" } } };
    const configured = {
      ...beforeConfig,
      channels: { matrix: { accounts: { ops: { enabled: true } } } },
    } satisfies OpenClawConfig;
    const hook = vi.fn();
    const isConfiguredWrite = (value: OpenClawConfig) =>
      value.channels?.matrix?.accounts?.ops?.enabled === true;
    setupChannels.mockImplementationOnce(async (_cfg, _runtime, _prompter, options) => {
      const setupOptions = options as {
        onPostWriteHook?: (value: {
          channel: "matrix";
          accountId: string;
          run: typeof hook;
        }) => void;
      };
      setupOptions.onPostWriteHook?.({ channel: "matrix", accountId: "ops", run: hook });
      return configured;
    });
    readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot(beforeConfig));

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime(),
      buildWizardPrompter({}),
    );

    const configuredWriteIndex = replaceConfigFile.mock.calls.findIndex(([params]) =>
      isConfiguredWrite(params.nextConfig),
    );
    expect(configuredWriteIndex).toBeGreaterThanOrEqual(0);
    expect(replaceConfigFile.mock.invocationCallOrder[configuredWriteIndex]).toBeLessThan(
      hook.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(hook).toHaveBeenCalledWith({ cfg: configured, runtime: expect.any(Object) });
    expect(hook.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeSetupWizard.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
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

    await runWizard({ skipChannels: false }, runtime, prompter);

    expect(setupChannels).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Channel side effect",
        navigation: { canGoBack: false, canGoForward: false },
      }),
    );
  });

  it.each([
    { name: "authenticates a provider", authChoice: "google-api-key" },
    { name: "skips an optional provider model picker", authChoice: "github-copilot" },
    { name: "honors a provider-required model picker", authChoice: "ollama" },
    { name: "configures a custom provider", authChoice: "custom-api-key" },
    { name: "keeps an explicit skip cold", authChoice: "skip" },
  ] as const)("$name while keeping the existing model config", async ({ authChoice }) => {
    const modelSelection = {
      promptWhenAuthChoiceProvided: true,
      allowKeepCurrent: authChoice !== "ollama",
    };
    if (authChoice === "ollama" || authChoice === "github-copilot") {
      if (authChoice === "ollama") {
        promptDefaultModel.mockResolvedValueOnce({ model: "ollama/llama3" });
      }
      resolveProviderPluginChoice.mockReturnValue({
        provider: providerPluginStub({
          id: authChoice,
          wizard: { setup: { modelSelection } },
        }),
        method: {
          id: authChoice === "ollama" ? "local" : "device",
          label: authChoice,
          kind: "custom",
          run: vi.fn(async () => ({ profiles: [] })),
        },
        wizard: { modelSelection },
      });
    }
    const existingConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "anthropic/sonnet-4.6" } },
        entries: { main: { default: true } },
      },
    };
    readConfigFileSnapshot.mockImplementation(async () =>
      configSnapshot(persistedWizardConfigs().at(-1) ?? existingConfig),
    );

    await runSetupWizard(
      {
        acceptRisk: true,
        authChoice,
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime(),
      buildWizardPrompter({}, { defaultSelect: "keep-model" }),
    );

    if (authChoice === "ollama") {
      expect(promptDefaultModel).toHaveBeenCalledWith(
        expect.objectContaining({ allowKeep: false }),
      );
    } else {
      expect(promptDefaultModel).not.toHaveBeenCalled();
    }
    if (authChoice === "custom-api-key") {
      expect(promptCustomApiConfig).toHaveBeenCalledWith(
        expect.objectContaining({ setAsPrimary: false }),
      );
    } else {
      expect(prepareAuthChoice).toHaveBeenCalledTimes(authChoice === "skip" ? 0 : 1);
    }
    const persistedConfig = persistedWizardConfigs().at(-1);
    expect(persistedConfig?.agents?.defaults?.model).toEqual({
      primary: authChoice === "ollama" ? "ollama/llama3" : "anthropic/sonnet-4.6",
    });
  });

  it.each([
    {
      name: "an API-key flag",
      optionKey: "nvidiaApiKey",
      authChoice: "nvidia-api-key",
      cliFlag: "--nvidia-api-key",
    },
    {
      name: "a provider token flag",
      optionKey: "githubCopilotToken",
      authChoice: "github-copilot",
      cliFlag: "--github-copilot-token",
    },
  ] as const)(
    "infers $name while preserving an existing default model",
    async ({ optionKey, authChoice, cliFlag }) => {
      resolveProviderOnboardAuthFlags.mockReturnValue([
        {
          optionKey,
          authChoice,
          cliFlag,
          cliOption: `${cliFlag} <key>`,
          description: "Provider credential",
        },
      ]);
      const existingConfig: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: "anthropic/sonnet-4.6" } },
          entries: { main: { default: true } },
        },
      };
      readConfigFileSnapshot.mockImplementation(async () =>
        configSnapshot(persistedWizardConfigs().at(-1) ?? existingConfig),
      );

      await runSetupWizard(
        {
          acceptRisk: true,
          [optionKey]: "provider-credential-fixture",
          installDaemon: false,
          skipChannels: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        createRuntime(),
        buildWizardPrompter({}, { defaultSelect: "keep-model" }),
      );

      expect(prepareAuthChoice).toHaveBeenCalledWith(
        expect.objectContaining({
          authChoice,
          opts: expect.objectContaining({ [optionKey]: "provider-credential-fixture" }),
        }),
      );
      expect(persistedWizardConfigs().at(-1)?.agents?.defaults?.model).toEqual({
        primary: "anthropic/sonnet-4.6",
      });
    },
  );

  it("rejects ambiguous provider credential flags before writing local setup state", async () => {
    resolveProviderOnboardAuthFlags.mockReturnValue([
      {
        optionKey: "nvidiaApiKey",
        authChoice: "nvidia-api-key",
        cliFlag: "--nvidia-api-key",
        cliOption: "--nvidia-api-key <key>",
        description: "NVIDIA API key",
      },
      {
        optionKey: "githubCopilotToken",
        authChoice: "github-copilot",
        cliFlag: "--github-copilot-token",
        cliOption: "--github-copilot-token <token>",
        description: "GitHub Copilot token",
      },
    ]);
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        nvidiaApiKey: "nvidia-credential-fixture",
        githubCopilotToken: "copilot-credential-fixture",
      },
      runtime,
      buildWizardPrompter({}),
    );

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Multiple provider credential flags"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(prepareAuthChoice).not.toHaveBeenCalled();
    expect(ensureOnboardingConfig).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
  });

  it("keeps an explicit auth skip cold when a provider credential flag is supplied", async () => {
    await runWizard(
      { authChoice: "skip", nvidiaApiKey: "nvidia-credential-fixture" },
      createRuntime(),
      buildWizardPrompter({}),
    );

    expect(resolveProviderOnboardAuthFlags).not.toHaveBeenCalled();
    expect(prepareAuthChoice).not.toHaveBeenCalled();
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
      .mockImplementationOnce(async (args) => ({
        config: {
          ...args.config,
          plugins: {
            ...args.config.plugins,
            entries: {
              ...args.config.plugins?.entries,
              "demo-provider-plugin": {
                enabled: true,
              },
            },
          },
        },
        retrySelection: true,
      }))
      .mockImplementationOnce(async (args) => ({
        config: {
          ...args.config,
          agents: {
            ...args.config.agents,
            defaults: {
              ...args.config.agents?.defaults,
              model: {
                primary: "demo-provider-two/model",
              },
            },
          },
        },
      }));

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
    const retryParams = requireRecord(
      getMockCallArg(applyAuthChoice, 1, 0, "retry auth choice"),
      "retry auth choice params",
    );
    expect(retryParams.authChoice).toBe("demo-provider-two");
    const retryConfig = requireRecord(retryParams.config, "retry auth choice config");
    expect(requireRecord(retryConfig.plugins, "retry plugins").entries).toEqual({
      "demo-provider-plugin": { enabled: true },
    });
    const retryAgents = requireRecord(retryConfig.agents, "retry agents");
    expect(retryAgents.entries).toEqual({ main: {} });
    expect(requireRecord(retryAgents.defaults, "retry defaults").workspace).toBe(
      "/tmp/openclaw-workspace",
    );
  });

  it("forwards provider-specific auth flags to applyAuthChoice opts", async () => {
    applyAuthChoice.mockReset();
    applyAuthChoice.mockImplementationOnce(async (args) => ({
      config: {
        ...args.config,
        agents: {
          ...args.config.agents,
          defaults: {
            ...args.config.agents?.defaults,
            model: { primary: "openai/gpt-5.5" },
          },
        },
      },
    }));

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runWizard(
      {
        authChoice: "openai-chatgpt-api-key",
        openaiApiKey: "sk-flag-value",
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
    applyAuthChoice.mockImplementationOnce(async (args) => ({
      config: {
        ...args.config,
        agents: {
          ...args.config.agents,
          defaults: {
            ...args.config.agents?.defaults,
            model: { primary: "google/gemini-3.1-pro-preview" },
          },
        },
      },
    }));

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runWizard({ authChoice: "google-api-key" }, runtime, prompter);

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
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
        gateway: {},
      }),
    );

    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const select = vi.fn(async () => "quickstart") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ note, select });
    const runtime = createRuntime();

    await runWizard({}, runtime, prompter);

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
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
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
      }),
    );
    const select = vi.fn(async () => "quickstart") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime();

    try {
      await runWizard({ mode: "local" }, runtime, prompter);
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

  it.each([
    {
      label: "explicit CLI gateway values",
      gatewayOptions: {
        gatewayPort: 19511,
        gatewayBind: "lan" as const,
        gatewayAuth: "password" as const,
        gatewayToken: "manual-gateway-token-placeholder",
        gatewayPassword: "manual-gateway-password-placeholder",
        tailscale: "off" as const,
      },
      expectedPort: 19511,
      expectedProbeAuth: {
        token: "manual-gateway-token-placeholder",
        password: "manual-gateway-password-placeholder",
      },
    },
    {
      label: "derived port when gateway values are omitted",
      gatewayOptions: {},
      expectedPort: 18789,
      expectedProbeAuth: {},
    },
  ])(
    "uses the $label for the manual probe and port prompt",
    async ({ gatewayOptions, expectedPort, expectedProbeAuth }) => {
      const prompter = buildWizardPrompter({});
      const runtime = createRuntime();

      await runWizard({ flow: "advanced", mode: "local", ...gatewayOptions }, runtime, prompter);

      expectRecordFields(
        getMockCallArg(probeGatewayReachable, 0, 0, "gateway probe"),
        { url: `ws://127.0.0.1:${expectedPort}`, ...expectedProbeAuth },
        "gateway probe params",
      );
      const gatewaySetup = expectRecordFields(
        getMockCallArg(configureGatewayForSetup, 0, 0, "gateway setup"),
        { localPort: expectedPort },
        "gateway setup params",
      );
      if (gatewayOptions.gatewayPort !== undefined) {
        expect(gatewaySetup.quickstartGateway).toMatchObject({
          port: 19511,
          bind: "lan",
          authMode: "password",
          token: "manual-gateway-token-placeholder",
          password: "manual-gateway-password-placeholder",
          tailscaleMode: "off",
        });
      }
    },
  );

  it("passes secretInputMode through to local gateway config step", async () => {
    configureGatewayForSetup.mockClear();
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runWizard(
      {
        flow: "quickstart",
        mode: "local",
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
        agents: { entries: { main: { default: true } } },
        gateway: {
          port: 19111,
          bind: "loopback",
          auth: { mode: "token", token: "stored-token" },
          tailscale: { mode: "off" },
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
          },
        },
      },
      settings: {
        port: args.quickstartGateway.port,
        bind: args.quickstartGateway.bind,
        authMode: args.quickstartGateway.authMode,
        gatewayToken: undefined,
        tailscaleMode: args.quickstartGateway.tailscaleMode,
      },
    }));

    await runWizard(
      {
        flow: "quickstart",
        mode: "local",
        gatewayPort: 19001,
        gatewayBind: "lan",
        gatewayAuth: "password",
        gatewayPassword: password,
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
      await runWizard({}, runtime, prompter);
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
      await runWizard({}, runtime, prompter);
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

  it.each([
    { provider: "openai", explicitLean: undefined, expectedLean: undefined },
    { provider: "managed-local", explicitLean: undefined, expectedLean: true },
    { provider: "managed-local", explicitLean: false, expectedLean: false },
    { provider: "managed-local", explicitLean: true, expectedLean: true },
  ])(
    "verifies and persists classic $provider setup with lean=$explicitLean",
    async ({ provider, explicitLean, expectedLean }) => {
      const managed = provider === "managed-local";
      const modelRef = `${provider}/test-model`;
      readConfigFileSnapshot.mockResolvedValue(
        configSnapshot({
          agents: { defaults: { experimental: { localModelLean: explicitLean } } },
        }),
      );
      replaceConfigFile.mockImplementation(async ({ nextConfig }) => {
        readConfigFileSnapshot.mockResolvedValue(configSnapshot(nextConfig));
        return { config: nextConfig };
      });
      applyAuthChoice.mockImplementationOnce(async (args) => ({
        config: {
          ...args.config,
          agents: {
            ...args.config.agents,
            defaults: {
              ...args.config.agents?.defaults,
              model: { primary: modelRef },
            },
          },
          ...(managed
            ? {
                models: {
                  providers: {
                    [provider]: {
                      baseUrl: "http://127.0.0.1:8080/v1",
                      models: [],
                      localService: { command: "/fixture/server" },
                    },
                  },
                },
              }
            : {}),
        },
      }));
      verifySetupInferenceConfig.mockImplementationOnce(async ({ config, verifyAgentTools }) => {
        expect(config.agents?.defaults?.experimental?.localModelLean).toBe(expectedLean);
        expect(verifyAgentTools).toBe(true);
        expect(replaceConfigFile).not.toHaveBeenCalled();
        return { ok: true, modelRef, latencyMs: 1 };
      });
      const confirm = vi.fn(async () => true) as unknown as WizardPrompter["confirm"];
      const prompter = buildWizardPrompter({ confirm });

      await runWizard({ authChoice: "demo-provider" }, createRuntime(), prompter);

      const optionalCheck = expect.objectContaining({
        message: "Test AI access now with a live completion?",
      });
      if (managed) {
        expect(confirm).not.toHaveBeenCalledWith(optionalCheck);
      } else {
        expect(confirm).toHaveBeenCalledWith(optionalCheck);
      }
      expect(verifySetupInferenceConfig).toHaveBeenCalledOnce();
      expect(persistedWizardConfigs().at(-1)?.agents?.defaults?.experimental?.localModelLean).toBe(
        expectedLean,
      );
      expect(persistedWizardConfigs().at(-1)?.wizard?.localModelLeanAutoModel).toBe(
        managed && explicitLean === undefined ? modelRef : undefined,
      );
    },
  );

  it("continues classic setup when live AI verification fails", async () => {
    applyAuthChoice.mockImplementationOnce(async (args) => ({
      config: {
        ...args.config,
        agents: {
          ...args.config.agents,
          defaults: {
            ...args.config.agents?.defaults,
            model: { primary: "openai/gpt-5.5" },
          },
        },
      },
    }));
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
    expect(persistedWizardConfigs().at(-1)?.agents?.defaults?.model).toBeUndefined();
  });

  it("does not persist staged model or auth choices when live verification is cancelled", async () => {
    const stateDir = await makeCaseDir("cancelled-auth-verification-");
    const agentDir = path.join(stateDir, "agent");
    const persistCalls = prepareMockAuthProfilesIn(agentDir);
    applyAuthChoice.mockResolvedValueOnce({
      config: modelConfigWithApiKey("test-cancelled-key"),
    });
    verifySetupInferenceConfig.mockRejectedValueOnce(new WizardCancelledError("cancelled"));
    replaceConfigFile.mockClear();

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
        buildWizardPrompter({ confirm: vi.fn(async () => true) }),
      ),
    ).rejects.toThrow("cancelled");

    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(persistCalls).toEqual([]);
    await expect(fs.access(agentDir)).rejects.toThrow();
  });

  it("keeps failed model/auth fixes in the verification loop without persisting them", async () => {
    const stateDir = await makeCaseDir("failed-auth-profile-retry-");
    const agentDir = path.join(stateDir, "agent");
    await upsertAuthProfileWithLock({ ...stagedOpenAiProfile("test-original-key"), agentDir });
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
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce("fix")
      .mockResolvedValueOnce("fix")
      .mockResolvedValueOnce("continue") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => true), select });

    try {
      await runWizard({ authChoice: "demo-provider" }, createRuntime(), prompter);

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
      expect(select).toHaveBeenCalledTimes(4);
      expect(thirdVerification.authProfiles).toEqual([
        stagedOpenAiProfile("test-retry-still-invalid-key"),
      ]);
      expect(
        persistedWizardConfigs().some(
          (config) =>
            config.models?.providers?.openai?.apiKey === "test-original-key" ||
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
      await runWizard({ authChoice: "demo-provider" }, createRuntime(), prompter);

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
      expect(persistCalls).toEqual([[stagedOpenAiProfile("test-retry-valid-key")]]);
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
      .mockResolvedValueOnce("__keep-current");
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
      await runWizard({ authChoice: "demo-provider" }, createRuntime(), prompter);

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
