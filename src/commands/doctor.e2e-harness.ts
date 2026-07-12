/** Shared Vitest harness mocks and helpers for doctor command e2e-style tests. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { afterEach, beforeEach, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import {
  readEmbeddedGatewayTokenForTest,
  testServiceAuditCodes,
} from "./doctor-service-audit.test-helpers.js";
import type { LegacyStateDetection } from "./doctor-state-migrations.js";

let originalIsTTY: boolean | undefined;
let originalStateDir: string | undefined;
let originalUpdateInProgress: string | undefined;
let tempStateDir: string | undefined;

function setStdinTty(value: boolean | undefined) {
  try {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  } catch {
    // ignore
  }
}

function createGatewayUpdateResult() {
  return {
    status: "skipped",
    mode: "unknown",
    steps: [],
    durationMs: 0,
  } as const;
}

function createCommandWithTimeoutResult() {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  } as const;
}

function createLegacyConfigSnapshot() {
  return {
    path: "/tmp/openclaw.json",
    exists: false,
    raw: null,
    parsed: {},
    valid: true,
    config: {},
    issues: [],
    legacyIssues: [],
  } as const;
}

const readConfigFileSnapshot = vi.fn() as unknown as MockFn;
export const confirm = vi.fn().mockResolvedValue(true) as unknown as MockFn;
const select = vi.fn().mockResolvedValue("node") as unknown as MockFn;
const note = vi.fn() as unknown as MockFn;
export const writeConfigFile = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
const resolveOpenClawPackageRoot = vi.fn().mockResolvedValue(null) as unknown as MockFn;
const runGatewayUpdate = vi
  .fn()
  .mockResolvedValue(createGatewayUpdateResult()) as unknown as MockFn;
const collectRelevantDoctorPluginIds = vi.fn(() => []) as unknown as MockFn;
const listPluginDoctorLegacyConfigRules = vi.fn(() => []) as unknown as MockFn;
const runDoctorHealthContributions = vi.fn(
  defaultRunDoctorHealthContributions,
) as unknown as MockFn;
const maybeRepairMemoryRecallHealth = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
const noteMemorySearchHealth = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
const noteMemoryRecallHealth = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
const migrateLegacyConfig = vi.fn((raw: unknown) => ({
  config: raw as Record<string, unknown>,
  changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
})) as unknown as MockFn;

const runExec = vi.fn().mockResolvedValue({
  stdout: "",
  stderr: "",
}) as unknown as MockFn;
const runCommandWithTimeout = vi
  .fn()
  .mockResolvedValue(createCommandWithTimeoutResult()) as unknown as MockFn;

export const ensureAuthProfileStore = vi
  .fn()
  .mockReturnValue({ version: 1, profiles: {} }) as unknown as MockFn;

const legacyReadConfigFileSnapshot = vi
  .fn()
  .mockResolvedValue(createLegacyConfigSnapshot()) as unknown as MockFn;
const createConfigIO = vi.fn(() => ({
  readConfigFileSnapshot: legacyReadConfigFileSnapshot,
})) as unknown as MockFn;

const findLegacyGatewayServices = vi.fn().mockResolvedValue([]) as unknown as MockFn;
const uninstallLegacyGatewayServices = vi.fn().mockResolvedValue([]) as unknown as MockFn;
const findExtraGatewayServices = vi.fn().mockResolvedValue([]) as unknown as MockFn;
const findSystemGatewayServices = vi.fn().mockResolvedValue([]) as unknown as MockFn;
const renderGatewayServiceCleanupHints = vi.fn().mockReturnValue(["cleanup"]) as unknown as MockFn;
const auditGatewayServiceConfig = vi
  .fn()
  .mockResolvedValue({ ok: true, issues: [] }) as unknown as MockFn;
const buildGatewayInstallPlan = vi.mocked(
  vi.fn().mockResolvedValue({
    programArguments: ["node", "cli", "gateway", "--port", "18789"],
    workingDirectory: "/tmp",
    environment: {},
  }),
) as unknown as MockFn;
const resolveGatewayAuthTokenForService = vi
  .fn()
  .mockResolvedValue({ token: undefined }) as unknown as MockFn;
const resolveGatewayProgramArguments = vi.fn().mockResolvedValue({
  programArguments: ["node", "cli", "gateway", "--port", "18789"],
}) as unknown as MockFn;
const serviceInstall = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
export const serviceIsLoaded = vi.fn().mockResolvedValue(false) as unknown as MockFn;
const serviceStop = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
export const serviceRestart = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
const serviceUninstall = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
const serviceReadCommand = vi.fn().mockResolvedValue(null) as unknown as MockFn;
export const callGateway = vi
  .fn()
  .mockRejectedValue(new Error("gateway closed")) as unknown as MockFn;

const autoMigrateLegacyStateDir = vi.fn().mockResolvedValue({
  migrated: false,
  skipped: false,
  changes: [],
  warnings: [],
}) as unknown as MockFn;
const autoMigrateLegacyState = vi.fn().mockResolvedValue({
  migrated: false,
  skipped: false,
  changes: [],
  warnings: [],
}) as unknown as MockFn;
const autoMigrateLegacyPluginDoctorState = vi.fn().mockResolvedValue({
  migrated: false,
  skipped: false,
  changes: [],
  warnings: [],
}) as unknown as MockFn;
const autoMigrateLegacyTaskStateSidecars = vi.fn().mockResolvedValue({
  migrated: false,
  skipped: false,
  changes: [],
  warnings: [],
}) as unknown as MockFn;
const runChannelPluginStartupMaintenance = vi
  .fn()
  .mockResolvedValue(undefined) as unknown as MockFn;

function defaultRunDoctorHealthContributions(ctx: {
  cfg: Record<string, unknown>;
  runtime: { log: (message: string) => void; error: (message: string) => void };
  prompter?: { shouldRepair?: boolean };
}) {
  if (ctx.prompter?.shouldRepair !== true) {
    return Promise.resolve();
  }
  const channels =
    ctx.cfg.channels && typeof ctx.cfg.channels === "object" && !Array.isArray(ctx.cfg.channels)
      ? Object.fromEntries(
          Object.entries(ctx.cfg.channels).map(([channelId, value]) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              return [channelId, value];
            }
            const channelConfig = { ...(value as Record<string, unknown>) };
            if (channelConfig.enabled === true) {
              delete channelConfig.enabled;
            }
            return [channelId, channelConfig];
          }),
        )
      : ctx.cfg.channels;
  return runChannelPluginStartupMaintenance({
    cfg: {
      ...ctx.cfg,
      ...(channels !== undefined ? { channels } : {}),
    },
    env: process.env,
    log: {
      info: (message: string) => ctx.runtime.log(message),
      warn: (message: string) => ctx.runtime.error(message),
    },
    trigger: "doctor-fix",
    logPrefix: "doctor",
  });
}

function createLegacyStateMigrationDetectionResult(params?: {
  hasLegacySessions?: boolean;
  preview?: string[];
}): LegacyStateDetection {
  return {
    targetAgentId: "main",
    targetMainKey: "main",
    targetScope: undefined,
    stateDir: "/tmp/state",
    oauthDir: "/tmp/oauth",
    sessions: {
      legacyDir: "/tmp/state/sessions",
      legacyStorePath: "/tmp/state/sessions/sessions.json",
      targetDir: "/tmp/state/agents/main/sessions",
      targetStorePath: "/tmp/state/agents/main/sessions/sessions.json",
      hasLegacy: params?.hasLegacySessions ?? false,
      legacyKeys: [],
      preserveAmbiguousKeys: false,
      preserveForeignMainAliases: false,
      targetStoreAliases: {
        hasDistinctAliases: false,
        hasFinalSymlink: false,
        hasUnresolvedIdentity: false,
      },
    },
    agentDir: {
      legacyDir: "/tmp/state/agent",
      targetDir: "/tmp/state/agents/main/agent",
      hasLegacy: false,
    },
    pluginStateSidecar: {
      sourcePath: "/tmp/state/plugin-state/state.sqlite",
      hasLegacy: false,
    },
    pluginInstallIndex: {
      sourcePath: "/tmp/state/plugins/installs.json",
      hasLegacy: false,
    },
    debugProxyCaptureSidecar: {
      sourcePath: "/tmp/state/debug-proxy/capture.sqlite",
      blobDir: "/tmp/state/debug-proxy/blobs",
      hasLegacy: false,
    },
    stateSchema: {
      hasLegacy: false,
      preview: [],
    },
    taskStateSidecars: {
      taskRunsPath: "/tmp/state/tasks/runs.sqlite",
      flowRunsPath: "/tmp/state/flows/registry.sqlite",
      hasLegacy: false,
    },
    deliveryQueues: {
      outboundPath: "/tmp/state/delivery-queue",
      sessionPath: "/tmp/state/session-delivery-queue",
      hasLegacy: false,
    },
    voiceWake: {
      triggersPath: "/tmp/state/settings/voicewake.json",
      routingPath: "/tmp/state/settings/voicewake-routing.json",
      hasLegacy: false,
    },
    updateCheck: {
      sourcePath: "/tmp/state/update-check.json",
      hasLegacy: false,
    },
    configHealth: {
      sourcePath: "/tmp/state/logs/config-health.json",
      hasLegacy: false,
    },
    pluginBindingApprovals: {
      sourcePath: "/tmp/state/plugin-binding-approvals.json",
      hasLegacy: false,
    },
    currentConversationBindings: {
      sourcePath: "/tmp/state/bindings/current-conversations.json",
      hasLegacy: false,
    },
    execApprovals: {
      sourcePath: "/tmp/state/exec-approvals.legacy.json",
      targetPath: "/tmp/state/exec-approvals.json",
      hasLegacy: false,
    },
    channelPlans: {
      hasLegacy: false,
      plans: [],
    },
    warnings: [],
    notices: [],
    preview: params?.preview ?? [],
  };
}

const detectLegacyStateMigrations = vi
  .fn()
  .mockResolvedValue(createLegacyStateMigrationDetectionResult()) as unknown as MockFn;

const runLegacyStateMigrations = vi.fn().mockResolvedValue({
  changes: [],
  warnings: [],
}) as unknown as MockFn;

const DEFAULT_CONFIG_SNAPSHOT = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
} as const;

vi.mock("@clack/prompts", () => ({
  confirm,
  intro: vi.fn(),
  note,
  outro: vi.fn(),
  select,
}));

vi.mock("../skills/discovery/status.js", () => ({
  buildWorkspaceSkillStatus: () => ({ skills: [] }),
}));

vi.mock("../plugins/loader.js", () => ({
  getRuntimePluginRegistryForLoadOptions: () => null,
  isPluginRegistryLoadInFlight: () => false,
  loadOpenClawPlugins: () => createEmptyPluginRegistry(),
  resolveCompatibleRuntimePluginRegistry: () => null,
  resolveRuntimePluginRegistry: () => null,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    CONFIG_PATH: "/tmp/openclaw.json",
    createConfigIO,
    readConfigFileSnapshot,
    writeConfigFile,
    migrateLegacyConfig,
  };
});

vi.mock("../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  return {
    ...actual,
    createConfigIO,
    readConfigFileSnapshot,
    writeConfigFile,
  };
});

vi.mock("../daemon/legacy.js", () => ({
  findLegacyGatewayServices,
  uninstallLegacyGatewayServices,
}));

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices,
  findSystemGatewayServices,
  renderGatewayServiceCleanupHints,
}));

vi.mock("../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig,
  needsNodeRuntimeMigration: vi.fn(() => false),
  readEmbeddedGatewayToken: readEmbeddedGatewayTokenForTest,
  SERVICE_AUDIT_CODES: testServiceAuditCodes,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("./doctor-gateway-auth-token.js", () => ({
  resolveGatewayAuthTokenForService,
}));

vi.mock("../gateway/call.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway/call.js")>("../gateway/call.js");
  return {
    ...actual,
    callGateway,
  };
});

vi.mock("../process/exec.js", () => ({
  runExec,
  runCommandWithTimeout,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isNonSecretApiKeyMarker: () => false,
}));

vi.mock("openclaw/plugin-sdk/provider-model-shared", () => ({
  DEFAULT_CONTEXT_TOKENS: 32768,
  normalizeProviderId: (value: string) => normalizeLowercaseStringOrEmpty(value),
}));

vi.mock("openclaw/plugin-sdk/provider-stream-shared", () => ({
  createMoonshotThinkingWrapper: () => undefined,
  resolveMoonshotThinkingType: () => undefined,
  streamWithPayloadPatch: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock("../infra/openclaw-root.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/openclaw-root.js")>();
  return {
    ...actual,
    resolveOpenClawPackageRoot,
  };
});

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate,
}));

vi.mock("../flows/doctor-health-contributions.js", () => ({
  runDoctorHealthContributions,
}));

vi.mock("./doctor-memory-search.js", () => ({
  maybeRepairMemoryRecallHealth,
  noteMemorySearchHealth,
  noteMemoryRecallHealth,
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  applyPluginDoctorCompatibilityMigrations: (config: unknown) => ({
    config,
    changes: [],
  }),
  collectRelevantDoctorPluginIds,
  listPluginDoctorLegacyConfigRules,
}));

vi.mock("../channels/plugins/doctor-contract-api.js", () => ({
  loadBundledChannelDoctorContractApi: vi.fn(() => undefined),
}));

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: vi.fn(() => undefined),
}));

vi.mock("../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/auth-profiles.js")>(
    "../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore,
  };
});

vi.mock("../agents/auth-profiles/store.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/auth-profiles/store.js")>(
    "../agents/auth-profiles/store.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore,
  };
});

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    install: serviceInstall,
    uninstall: serviceUninstall,
    stop: serviceStop,
    restart: serviceRestart,
    isLoaded: serviceIsLoaded,
    readCommand: serviceReadCommand,
    readRuntime: vi.fn().mockResolvedValue({ status: "running" }),
  }),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn().mockResolvedValue({ code: "000000", created: false }),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: () => {},
    error: () => {},
    exit: () => {
      throw new Error("exit");
    },
  },
}));

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    resolveUserPath: (value: string) => value,
    sleep: vi.fn(),
  };
});

vi.mock("./health.js", () => ({
  healthCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./onboard-helpers.js", () => ({
  applyWizardMetadata: (cfg: Record<string, unknown>) => cfg,
  DEFAULT_WORKSPACE: "/tmp",
  guardCancel: (value: unknown) => value,
  printWizardHeader: vi.fn(),
  randomToken: vi.fn(() => "test-gateway-token"),
}));

vi.mock("./doctor-state-migrations.js", () => ({
  autoMigrateLegacyPluginDoctorState,
  autoMigrateLegacyState,
  autoMigrateLegacyStateDir,
  autoMigrateLegacyTaskStateSidecars,
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
}));

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance,
}));

/** Configures the mocked doctor config snapshot with a partial snapshot override. */
export function mockDoctorConfigSnapshot(
  params: {
    config?: Record<string, unknown>;
    parsed?: Record<string, unknown>;
    valid?: boolean;
    issues?: Array<{ path: string; message: string }>;
    legacyIssues?: Array<{ path: string; message: string }>;
  } = {},
) {
  readConfigFileSnapshot.mockResolvedValue({
    ...DEFAULT_CONFIG_SNAPSHOT,
    config: params.config ?? DEFAULT_CONFIG_SNAPSHOT.config,
    parsed: params.parsed ?? DEFAULT_CONFIG_SNAPSHOT.parsed,
    valid: params.valid ?? DEFAULT_CONFIG_SNAPSHOT.valid,
    issues: params.issues ?? DEFAULT_CONFIG_SNAPSHOT.issues,
    legacyIssues: params.legacyIssues ?? DEFAULT_CONFIG_SNAPSHOT.legacyIssues,
  });
}

/** Creates a runtime mock that captures doctor command output and exits. */
export function createDoctorRuntime() {
  return {
    log: vi.fn() as unknown as MockFn,
    error: vi.fn() as unknown as MockFn,
    exit: vi.fn() as unknown as MockFn,
  };
}

/** Sets up temporary legacy state paths and mocked config for migration tests. */
export async function arrangeLegacyStateMigrationTest(): Promise<{
  doctorCommand: unknown;
  runtime: { log: MockFn; error: MockFn; exit: MockFn };
  detectLegacyStateMigrations: MockFn;
  runLegacyStateMigrations: MockFn;
}> {
  mockDoctorConfigSnapshot();

  const { doctorCommand } = await import("./doctor.js");
  const runtime = createDoctorRuntime();

  detectLegacyStateMigrations.mockClear();
  runLegacyStateMigrations.mockClear();
  detectLegacyStateMigrations.mockResolvedValue(
    createLegacyStateMigrationDetectionResult({
      hasLegacySessions: true,
      preview: ["- Legacy sessions detected"],
    }),
  );
  runLegacyStateMigrations.mockResolvedValueOnce({
    changes: ["migrated"],
    warnings: [],
  });

  confirm.mockClear();

  return {
    doctorCommand,
    runtime,
    detectLegacyStateMigrations,
    runLegacyStateMigrations,
  };
}

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true);
  select.mockReset().mockResolvedValue("node");
  note.mockClear();

  readConfigFileSnapshot.mockReset();
  writeConfigFile.mockReset().mockResolvedValue(undefined);
  resolveOpenClawPackageRoot.mockReset().mockResolvedValue(null);
  runGatewayUpdate.mockReset().mockResolvedValue(createGatewayUpdateResult());
  listPluginDoctorLegacyConfigRules.mockReset().mockReturnValue([]);
  runDoctorHealthContributions.mockReset().mockImplementation(defaultRunDoctorHealthContributions);
  maybeRepairMemoryRecallHealth.mockReset().mockResolvedValue(undefined);
  noteMemorySearchHealth.mockReset().mockResolvedValue(undefined);
  noteMemoryRecallHealth.mockReset().mockResolvedValue(undefined);
  legacyReadConfigFileSnapshot.mockReset().mockResolvedValue(createLegacyConfigSnapshot());
  createConfigIO.mockReset().mockImplementation(() => ({
    readConfigFileSnapshot: legacyReadConfigFileSnapshot,
  }));
  runExec.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  runCommandWithTimeout.mockReset().mockResolvedValue(createCommandWithTimeoutResult());
  ensureAuthProfileStore.mockReset().mockReturnValue({ version: 1, profiles: {} });
  migrateLegacyConfig.mockReset().mockImplementation((raw: unknown) => ({
    config: raw as Record<string, unknown>,
    changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
  }));
  findLegacyGatewayServices.mockReset().mockResolvedValue([]);
  uninstallLegacyGatewayServices.mockReset().mockResolvedValue([]);
  findExtraGatewayServices.mockReset().mockResolvedValue([]);
  renderGatewayServiceCleanupHints.mockReset().mockReturnValue(["cleanup"]);
  auditGatewayServiceConfig.mockReset().mockResolvedValue({ ok: true, issues: [] });
  buildGatewayInstallPlan.mockReset().mockResolvedValue({
    programArguments: ["node", "cli", "gateway", "--port", "18789"],
    workingDirectory: "/tmp",
    environment: {},
  });
  resolveGatewayAuthTokenForService.mockReset().mockResolvedValue({ token: undefined });
  resolveGatewayProgramArguments.mockReset().mockResolvedValue({
    programArguments: ["node", "cli", "gateway", "--port", "18789"],
  });
  serviceInstall.mockReset().mockResolvedValue(undefined);
  serviceIsLoaded.mockReset().mockResolvedValue(false);
  serviceStop.mockReset().mockResolvedValue(undefined);
  serviceRestart.mockReset().mockResolvedValue(undefined);
  serviceUninstall.mockReset().mockResolvedValue(undefined);
  serviceReadCommand.mockReset().mockResolvedValue(null);
  callGateway.mockReset().mockRejectedValue(new Error("gateway closed"));
  autoMigrateLegacyStateDir.mockReset().mockResolvedValue({
    migrated: false,
    skipped: false,
    changes: [],
    warnings: [],
  });
  autoMigrateLegacyState.mockReset().mockResolvedValue({ changes: [], warnings: [] });
  autoMigrateLegacyTaskStateSidecars.mockReset().mockResolvedValue({ changes: [], warnings: [] });
  runChannelPluginStartupMaintenance.mockReset().mockResolvedValue(undefined);

  originalIsTTY = process.stdin.isTTY;
  setStdinTty(true);
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-state-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  fs.mkdirSync(path.join(tempStateDir, "agents", "main", "sessions"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tempStateDir, "credentials"), { recursive: true });
});

afterEach(() => {
  setStdinTty(originalIsTTY);
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  if (originalUpdateInProgress === undefined) {
    delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  } else {
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
  }
  if (tempStateDir) {
    fs.rmSync(tempStateDir, { recursive: true, force: true });
    tempStateDir = undefined;
  }
});
