/** Shared Vitest harness mocks and helpers for doctor command e2e-style tests. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { afterEach, beforeEach, vi } from "vitest";
import type { LegacyStateDetection } from "../infra/state-migrations.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { defineMockFn, type MockFn } from "../test-utils/vitest-mock-fn.js";
import {
  readEmbeddedGatewayTokenForTest,
  testServiceAuditCodes,
} from "./doctor-service-audit.test-helpers.js";
import {
  applyMockDoctorConfigSnapshot,
  arrangeLegacyStateMigrationFixture,
  createCommandWithTimeoutResult,
  createDoctorServiceMocks,
  createDoctorRuntime as createDoctorRuntimeFixture,
  createGatewayUpdateResult,
  createLegacyConfigSnapshot,
  type DoctorConfigSnapshotFixtureParams,
  setDoctorStdinTty,
} from "./doctor.e2e-harness.test-helpers.js";

let originalIsTTY: boolean | undefined;
let originalStateDir: string | undefined;
let originalUpdateInProgress: string | undefined;
let tempStateDir: string | undefined;

export const readConfigFileSnapshot = defineMockFn(vi.fn());
export const confirm = defineMockFn(vi.fn().mockResolvedValue(true));
const select = defineMockFn(vi.fn().mockResolvedValue("node"));
const note = defineMockFn(vi.fn());
export const writeConfigFile = defineMockFn(vi.fn().mockResolvedValue(undefined));
export const resolveOpenClawPackageRoot = defineMockFn(vi.fn().mockResolvedValue(null));
export const runGatewayUpdate = defineMockFn(
  vi.fn().mockResolvedValue(createGatewayUpdateResult()),
);
const listPluginDoctorLegacyConfigRules = defineMockFn(vi.fn(() => []));
const runDoctorHealthContributions = defineMockFn(vi.fn(defaultRunDoctorHealthContributions));
const maybeRepairMemoryRecallHealth = defineMockFn(vi.fn().mockResolvedValue(undefined));
const noteMemorySearchHealth = defineMockFn(vi.fn().mockResolvedValue(undefined));
const noteMemoryRecallHealth = defineMockFn(vi.fn().mockResolvedValue(undefined));
const migrateLegacyConfig = defineMockFn(
  vi.fn((raw: unknown) => ({
    config: raw as Record<string, unknown>,
    changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
  })),
);

const runExec = defineMockFn(
  vi.fn().mockResolvedValue({
    stdout: "",
    stderr: "",
  }),
);
export const runCommandWithTimeout = defineMockFn(
  vi.fn().mockResolvedValue(createCommandWithTimeoutResult()),
);

export const ensureAuthProfileStore = defineMockFn(
  vi.fn().mockReturnValue({ version: 1, profiles: {} }),
);

const legacyReadConfigFileSnapshot = defineMockFn(
  vi.fn().mockResolvedValue(createLegacyConfigSnapshot()),
);
const createConfigIO = defineMockFn(
  vi.fn(() => ({
    configPath: "/tmp/openclaw.json",
    readConfigFileSnapshot: legacyReadConfigFileSnapshot,
  })),
);

const {
  auditGatewayServiceConfig,
  buildGatewayInstallPlan,
  callGateway,
  findExtraGatewayServices,
  findLegacyGatewayServices,
  findSystemGatewayServices,
  renderGatewayServiceCleanupHints,
  resolveGatewayAuthTokenForService,
  resolveGatewayProgramArguments,
  serviceInstall,
  serviceIsLoaded,
  serviceReadCommand,
  serviceRestart,
  serviceStop,
  serviceUninstall,
  uninstallLegacyGatewayServices,
} = createDoctorServiceMocks();
export { callGateway, serviceIsLoaded, serviceRestart };

export const autoMigrateLegacyStateDir = defineMockFn(
  vi.fn().mockResolvedValue({
    migrated: false,
    skipped: false,
    changes: [],
    warnings: [],
  }),
);
const autoMigrateLegacyState = defineMockFn(
  vi.fn().mockResolvedValue({
    migrated: false,
    skipped: false,
    changes: [],
    warnings: [],
  }),
);
const autoMigrateLegacyPluginDoctorState = defineMockFn(
  vi.fn().mockResolvedValue({
    migrated: false,
    skipped: false,
    changes: [],
    warnings: [],
  }),
);
const autoMigrateLegacyTaskStateSidecars = defineMockFn(
  vi.fn().mockResolvedValue({
    migrated: false,
    skipped: false,
    changes: [],
    warnings: [],
  }),
);
const runChannelPluginStartupMaintenance = defineMockFn(vi.fn().mockResolvedValue(undefined));

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
    stateDir: "/tmp/state",
    oauthDir: "/tmp/oauth",
    deviceAuth: {
      sourcePath: "/tmp/state/identity/device-auth.json",
      sourcePresent: false,
      hasLegacy: false,
    },
    deviceIdentity: {
      sourcePath: "/tmp/state/identity/device.json",
      claimPath: "/tmp/state/identity/device.json.doctor-importing",
      nativeClaimPath: "/tmp/state/identity/device.json.native-importing",
      hasLegacy: false,
      hasInvalidCanonical: false,
    },
    mcpOauth: {
      sourceDir: "/tmp/state/mcp-oauth",
      sourcePaths: [],
      hasLegacy: false,
    },
    execApprovals: {
      sourcePath: "/tmp/state/exec-approvals.json",
      hasLegacy: false,
    },
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
    sharedAuthStore: {
      sourcePath: "/tmp/state/agents/main/agent/openclaw-agent.sqlite",
      hasLegacy: false,
    },
    worktrees: { hasLegacy: false, pathRewrites: [] },
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
    tuiLastSessions: {
      sourcePath: "/tmp/state/tui/last-session.json",
      hasLegacy: false,
    },
    auditLogs: {
      sources: [],
      hasLegacy: false,
    },
    acpReplayLedger: {
      sourcePath: "/tmp/state/acp/event-ledger.json",
      hasLegacy: false,
    },
    managedOutgoingImages: {
      sourceDir: "/tmp/state/media/outgoing/records",
      hasLegacy: false,
    },
    apns: {
      sourcePath: "/tmp/state/push/apns-registrations.json",
      hasLegacy: false,
    },
    workspace: {
      sources: [],
      hasLegacy: false,
    },
    webPush: {
      subscriptionsPath: "/tmp/state/push/web-push-subscriptions.json",
      vapidKeysPath: "/tmp/state/push/vapid-keys.json",
      hasLegacy: false,
    },
    nodeHost: {
      sourcePath: "/tmp/state/node.json",
      hasLegacy: false,
    },
    subagentRegistry: {
      sourcePath: "/tmp/state/subagents/runs.json",
      hasLegacy: false,
    },
    rescuePending: {
      sourcePaths: ["/tmp/state/crestodian/rescue-pending", "/tmp/state/openclaw/rescue-pending"],
      hasLegacy: false,
    },
    channelPairing: {
      sourceDir: "/tmp/oauth",
      files: [],
      knownChannelIds: [],
      defaultAccountIds: {},
      accountIds: {},
      hasLegacy: false,
    },
    warnings: [],
    notices: [],
    preview: params?.preview ?? [],
  };
}

const detectLegacyStateMigrations = defineMockFn(
  vi.fn().mockResolvedValue(createLegacyStateMigrationDetectionResult()),
);

const runLegacyStateMigrations = defineMockFn(
  vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
);

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
  loadPluginRegistryHandle: () => createEmptyPluginRegistry(),
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

vi.mock("../flows/doctor-core-checks.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/doctor-core-checks.runtime.js")>()),
  collectRuntimeToolSchemaFindings: vi.fn().mockResolvedValue([]),
}));

vi.mock("./doctor/shared/active-tool-schema-warnings.js", () => ({
  collectActiveToolSchemaProjectionWarnings: vi.fn().mockResolvedValue([]),
}));

vi.mock("./doctor-browser.js", () => ({
  detectLegacyClawdBrowserProfileResidue: vi.fn().mockResolvedValue(null),
  maybeArchiveLegacyClawdBrowserProfileResidue: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
  maybeRepairOwnedChromeExtensionNativeHosts: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
  noteChromeMcpBrowserReadiness: vi.fn().mockResolvedValue(undefined),
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
  collectDoctorConfigRepairPluginIds: () => [],
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
    ensureAuthProfileStoreWithoutExternalProfiles: ensureAuthProfileStore,
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

vi.mock("../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
  return {
    ExitError: actual.ExitError,
    defaultRuntime: {
      log: () => {},
      error: () => {},
      exit: () => {
        throw new Error("exit");
      },
    },
  };
});

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
  healthCommandNonExiting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./onboard-helpers.js", () => ({
  applyWizardMetadata: (cfg: Record<string, unknown>) => cfg,
  DEFAULT_WORKSPACE: "/tmp",
  guardCancel: (value: unknown) => value,
  printWizardHeader: vi.fn(),
  randomToken: vi.fn(() => "test-gateway-token"),
}));

vi.mock("../infra/state-migrations.doctor.js", () => ({
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
}));

vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  autoMigrateLegacyPluginDoctorState,
}));

vi.mock("../infra/state-migrations.state-dir.js", () => ({
  autoMigrateLegacyStateDir,
  autoMigrateLegacyTaskStateSidecars,
}));

vi.mock("../infra/state-migrations.config-machine-state.js", () => ({
  migrateLegacyConfigMachineState: vi.fn(() => ({ changes: [], warnings: [] })),
}));

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance,
}));

/** Configures the mocked doctor config snapshot with a partial snapshot override. */
export function mockDoctorConfigSnapshot(params: DoctorConfigSnapshotFixtureParams = {}): void {
  applyMockDoctorConfigSnapshot(readConfigFileSnapshot, params);
}

export const createDoctorRuntime = createDoctorRuntimeFixture;

/** Sets up temporary legacy state paths and mocked config for migration tests. */
export async function arrangeLegacyStateMigrationTest(): Promise<{
  doctorCommand: unknown;
  runtime: { log: MockFn; error: MockFn; exit: MockFn };
  detectLegacyStateMigrations: MockFn;
  runLegacyStateMigrations: MockFn;
}> {
  return arrangeLegacyStateMigrationFixture({
    confirm,
    createDetection: createLegacyStateMigrationDetectionResult,
    detectLegacyStateMigrations,
    mockDoctorConfigSnapshot,
    runLegacyStateMigrations,
  });
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
    configPath: "/tmp/openclaw.json",
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
  setDoctorStdinTty(true);
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
  setDoctorStdinTty(originalIsTTY);
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
