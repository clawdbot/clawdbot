import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
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

function buildBundledPluginModuleId(pluginId: string, artifactBasename: string): string {
  return ["..", "..", "extensions", pluginId, artifactBasename].join("/");
}

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

export const readConfigFileSnapshot = vi.fn() as unknown as MockFn;
export const confirm = vi.fn().mockResolvedValue(true) as unknown as MockFn;
export const select = vi.fn().mockResolvedValue("node") as unknown as MockFn;
export const note = vi.fn() as unknown as MockFn;
export const writeConfigFile = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
export const resolveOpenClawPackageRoot = vi.fn().mockResolvedValue(null) as unknown as MockFn;
export const runGatewayUpdate = vi
  .fn()
  .mockResolvedValue(createGatewayUpdateResult()) as unknown as MockFn;
export const collectRelevantDoctorPluginIds = vi.fn(() => []) as unknown as MockFn;
export const listPluginDoctorLegacyConfigRules = vi.fn(() => []) as unknown as MockFn;
export const runDoctorHealthContributions = vi.fn(
  defaultRunDoctorHealthContributions,
) as unknown as MockFn;
export const maybeRepairMemoryRecallHealth = vi
  .fn()
  .mockResolvedValue(undefined) as unknown as MockFn;
export const noteMemorySearchHealth = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
export const noteMemoryRecallHealth = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
export const migrateLegacyConfig = vi.fn((raw: unknown) => ({
  config: raw as Record<string, unknown>,
  changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
})) as unknown as MockFn;

export const runExec = vi.fn().mockResolvedValue({
  stdout: "",
  stderr: "",
}) as unknown as MockFn;
export const runCommandWithTimeout = vi
  .fn()
  .mockResolvedValue(createCommandWithTimeoutResult()) as unknown as MockFn;

export const ensureAuthProfileStore = vi
  .fn()
  .mockReturnValue({ version: 1, profiles: {} }) as unknown as MockFn;

export const legacyReadConfigFileSnapshot = vi
  .fn()
  .mockResolvedValue(createLegacyConfigSnapshot()) as unknown as MockFn;
export const createConfigIO = vi.fn(() => ({
  readConfigFileSnapshot: legacyReadConfigFileSnapshot,
})) as unknown as MockFn;

export const findLegacyGatewayServices = vi.fn().mockResolvedValue([]) as unknown as MockFn;
export const uninstallLegacyGatewayServices = vi.fn().mockResolvedValue([]) as unknown as MockFn;
export const findExtraGatewayServices = vi.fn().mockResolvedValue([]) as unknown as MockFn;
export const renderGatewayServiceCleanupHints = vi
  .fn()
  .mockReturnValue(["cleanup"]) as unknown as MockFn;
export const auditGatewayServiceConfig = vi
  .fn()
  .mockResolvedValue({ ok: true, issues: [] }) as unknown as MockFn;
export const buildGatewayInstallPlan = vi.mocked(
  vi.fn().mockResolvedValue({
    programArguments: ["node", "cli", "gateway", "--port", "18789"],
    workingDirectory: "/tmp",
    environment: {},
  }),
) as unknown as MockFn;
export const resolveGatewayAuthTokenForService = vi
  .fn()
  .mockResolvedValue({ token: undefined }) as unknown as MockFn;
export const resolveGatewayProgramArguments = vi.fn().mockResolvedValue({
  programArguments: ["node", "cli", "gateway", "--port", "18789"],
}) as unknown as MockFn;
export const serviceInstall = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
export const serviceIsLoaded = vi.fn().mockResolvedValue(false) as unknown as MockFn;
export const serviceStop = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
export const serviceRestart = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
export const serviceUninstall = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
export const serviceReadCommand = vi.fn().mockResolvedValue(null) as unknown as MockFn;
export const callGateway = vi
  .fn()
  .mockRejectedValue(new Error("gateway closed")) as unknown as MockFn;

export const autoMigrateLegacyStateDir = vi.fn().mockResolvedValue({
  migrated: false,
  skipped: false,
  changes: [],
  warnings: [],
}) as unknown as MockFn;
export const runChannelPluginStartupMaintenance = vi
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
    },
    agentDir: {
      legacyDir: "/tmp/state/agent",
      targetDir: "/tmp/state/agents/main/agent",
      hasLegacy: false,
    },
    channelPlans: {
      hasLegacy: false,
      plans: [],
    },
    preview: params?.preview ?? [],
  };
}

export const detectLegacyStateMigrations = vi
  .fn()
  .mockResolvedValue(createLegacyStateMigrationDetectionResult()) as unknown as MockFn;

export const runLegacyStateMigrations = vi.fn().mockResolvedValue({
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

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: () => ({ skills: [] }),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: () => createEmptyPluginRegistry(),
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

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot,
  resolveOpenClawPackageRootSync: vi.fn(() => "/tmp/openclaw"),
}));

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
  collectRelevantDoctorPluginIds,
  listPluginDoctorLegacyConfigRules,
}));

vi.mock("./doctor-bundled-plugin-runtime-deps.js", () => ({
  maybeRepairBundledPluginRuntimeDeps: vi.fn(async () => {}),
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

vi.mock(buildBundledPluginModuleId("telegram", "api.js"), () => ({
  resolveTelegramToken: vi.fn(() => ({ token: "", source: "none" })),
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
  autoMigrateLegacyStateDir,
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
}));

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance,
}));

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

export function createDoctorRuntime() {
  return {
    log: vi.fn() as unknown as MockFn,
    error: vi.fn() as unknown as MockFn,
    exit: vi.fn() as unknown as MockFn,
  };
}

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
  detectLegacyStateMigrations.mockResolvedValueOnce(
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
