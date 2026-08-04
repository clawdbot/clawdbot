// Doctor config preflight tests cover plugin quarantine behavior during startup preflight.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyConfigIssue } from "../config/types.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";

type StartupConvergenceWarning = {
  pluginId?: string;
  reason: string;
  message: string;
  guidance: string[];
};

type StartupSmokeFailure = {
  pluginId: string;
  installPath?: string;
  reason: "missing-install-path" | "missing-main-entry" | "unreadable-package-json";
  detail: string;
};

type StartupConvergenceResult = {
  changes: string[];
  notices?: StartupConvergenceWarning[];
  warnings: StartupConvergenceWarning[];
  errored: boolean;
  smokeFailures: StartupSmokeFailure[];
  installRecords: Record<string, unknown>;
};

type StateMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

const autoMigrateLegacyStateDir = vi.hoisted(() =>
  vi.fn(
    async (): Promise<StateMigrationResult> => ({
      migrated: false,
      skipped: false,
      changes: [],
      warnings: [],
    }),
  ),
);
const autoMigrateLegacyState = vi.hoisted(() =>
  vi.fn(
    async (): Promise<StateMigrationResult> => ({
      migrated: true,
      skipped: false,
      changes: ["imported"],
      warnings: [],
    }),
  ),
);
const autoMigrateLegacyPluginDoctorState = vi.hoisted(() =>
  vi.fn(
    async (): Promise<StateMigrationResult> => ({
      migrated: true,
      skipped: false,
      changes: ["plugin-imported"],
      warnings: [],
    }),
  ),
);
const autoMigrateLegacyTaskStateSidecars = vi.hoisted(() =>
  vi.fn(
    async (): Promise<StateMigrationResult> => ({
      migrated: true,
      skipped: false,
      changes: ["task-imported"],
      warnings: [],
    }),
  ),
);
const migrateLegacyMediaPersistence = vi.hoisted(() =>
  vi.fn(() => ({ changes: [], warnings: [] })),
);
const repairLegacyCronStoreWithoutPrompt = vi.hoisted(() =>
  vi.fn(async () => ({ changes: ["cron-imported"], warnings: [] })),
);
const collectCronCodexRuntimePolicyTargetsReadOnly = vi.hoisted(() =>
  vi.fn(async () => ({ targets: [], warnings: [] })),
);
const planPristineStartupStateMigrations = vi.hoisted(() =>
  vi.fn(() => ({
    skipAllStateMigrations: false,
    skipCoreStateMigrations: false,
  })),
);
const needsStateMigrationCheckpoint = vi.hoisted(() => vi.fn(() => false));
const needsStartupMigrationCheckpoint = vi.hoisted(() => vi.fn(() => false));
const startupMigrationLeaseHeartbeat = vi.hoisted(() => vi.fn());
const startupMigrationLeaseRelease = vi.hoisted(() => vi.fn());
const startupMigrationLeaseAssertOwnedInTransaction = vi.hoisted(() => vi.fn());
const startupMigrationLease = vi.hoisted(() => ({
  assertOwnedInTransaction: startupMigrationLeaseAssertOwnedInTransaction,
  heartbeat: startupMigrationLeaseHeartbeat,
  owner: "startup-test-owner",
  release: startupMigrationLeaseRelease,
}));
const acquireStartupMigrationLease = vi.hoisted(() =>
  vi.fn((_params: { env: NodeJS.ProcessEnv }) => startupMigrationLease),
);
const recordSuccessfulStateMigrations = vi.hoisted(() => vi.fn());
const recordSuccessfulStartupMigrations = vi.hoisted(() => vi.fn());
const writePersistedInstalledPluginIndexWithLeaseSync = vi.hoisted(() => vi.fn());
const runPostCorePluginConvergence = vi.hoisted(() =>
  vi.fn(
    async (): Promise<StartupConvergenceResult> => ({
      changes: [],
      notices: [],
      warnings: [],
      errored: false,
      smokeFailures: [],
      installRecords: {},
    }),
  ),
);
const runActivePluginPayloadSmokeCheck = vi.hoisted(() =>
  vi.fn(async () => ({ checked: [] as string[], failures: [] as StartupSmokeFailure[] })),
);
const planStartupPluginConvergence = vi.hoisted(() =>
  vi.fn(async () => ({ required: true, installRecords: {} })),
);
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    exists: true,
    valid: true,
    config: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    sourceConfig: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    parsed: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    legacyIssues: [] as Array<{ path: string; message: string }>,
    warnings: [] as Array<{ path: string; message: string }>,
    issues: [] as Array<{ path: string; message: string }>,
  })),
);
const pluginMigrationFingerprint = vi.hoisted(() => vi.fn(() => "plugin-migrations"));
type ConfigSnapshotWithPluginMetadataFixture = {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  pluginMetadataSnapshot?: {
    configFingerprint?: string;
    index?: unknown;
    registrySource?: "derived" | "persisted";
  };
};
const readConfigFileSnapshotWithPluginMetadata = vi.hoisted(() =>
  vi.fn<
    (options?: {
      allowCurrentPluginMetadata?: boolean;
    }) => Promise<ConfigSnapshotWithPluginMetadataFixture>
  >(async () => ({
    snapshot: await readConfigFileSnapshot(),
    pluginMetadataSnapshot: { configFingerprint: pluginMigrationFingerprint() },
  })),
);
const findDoctorLegacyConfigIssues = vi.hoisted(() => vi.fn((): LegacyConfigIssue[] => []));
const addDoctorLegacyIssues = vi.hoisted(() => vi.fn(<T>(snapshot: T): T => snapshot));
const runWithPluginMetadataSnapshot = vi.hoisted(() =>
  vi.fn((_scope: unknown, run: () => unknown) => run()),
);
const note = vi.hoisted(() => vi.fn());

const makeStartupConvergenceResult = vi.hoisted(
  () =>
    (overrides: Partial<StartupConvergenceResult> = {}): StartupConvergenceResult => ({
      changes: [],
      notices: [],
      warnings: [],
      errored: false,
      smokeFailures: [],
      installRecords: {},
      ...overrides,
    }),
);

vi.mock("./doctor-state-migrations.js", () => ({
  autoMigrateLegacyState,
  autoMigrateLegacyStateDir,
  autoMigrateLegacyPluginDoctorState,
  autoMigrateLegacyTaskStateSidecars,
  migrateLegacyMediaPersistence,
}));

vi.mock("./doctor/cron/legacy-repair.js", () => ({
  collectCronCodexRuntimePolicyTargetsReadOnly,
  repairLegacyCronStoreWithoutPrompt,
}));

vi.mock("../infra/startup-migration-checkpoint.js", () => ({
  acquireStartupMigrationLease,
  needsStateMigrationCheckpoint,
  needsStartupMigrationCheckpoint,
  recordSuccessfulStateMigrations,
  recordSuccessfulStartupMigrations,
}));

vi.mock("../plugins/installed-plugin-index-store.js", () => ({
  writePersistedInstalledPluginIndexWithLeaseSync,
}));

vi.mock("../cli/update-cli/active-plugin-payload-validation.js", () => ({
  runActivePluginPayloadSmokeCheck,
}));

vi.mock("../cli/update-cli/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence,
}));

vi.mock("./doctor/shared/startup-plugin-convergence-plan.js", () => ({
  planStartupPluginConvergence,
}));

vi.mock("./doctor/shared/pristine-startup-state.js", () => ({
  planPristineStartupStateMigrations,
}));

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  recoverConfigFromJsonRootSuffix: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
}));

vi.mock("./doctor/shared/legacy-config-issues.js", () => ({
  addDoctorLegacyIssues,
  findDoctorLegacyConfigIssues,
}));

vi.mock("./doctor/shared/plugin-metadata-snapshot-scope.js", () => ({
  createDoctorPluginMetadataSnapshotScope: () => ({
    run: runWithPluginMetadataSnapshot,
    invalidate: vi.fn(),
  }),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

describe("runDoctorConfigPreflight plugin quarantine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pluginMigrationFingerprint.mockReset();
    pluginMigrationFingerprint.mockReturnValue("plugin-migrations");
    findDoctorLegacyConfigIssues.mockReset();
    findDoctorLegacyConfigIssues.mockReturnValue([]);
    setActiveDegradedPlugins([]);
    needsStartupMigrationCheckpoint.mockReturnValue(false);
    needsStateMigrationCheckpoint.mockImplementation(() => needsStartupMigrationCheckpoint());
    runPostCorePluginConvergence.mockResolvedValue(makeStartupConvergenceResult());
    planStartupPluginConvergence.mockResolvedValue({ required: true, installRecords: {} });
    planPristineStartupStateMigrations.mockReturnValue({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: false,
    });
    autoMigrateLegacyStateDir.mockResolvedValue({
      migrated: false,
      skipped: false,
      changes: [],
      warnings: [],
    });
    autoMigrateLegacyState.mockResolvedValue({
      migrated: true,
      skipped: false,
      changes: ["imported"],
      warnings: [],
    });
    autoMigrateLegacyPluginDoctorState.mockResolvedValue({
      migrated: true,
      skipped: false,
      changes: ["plugin-imported"],
      warnings: [],
    });
    autoMigrateLegacyTaskStateSidecars.mockResolvedValue({
      migrated: true,
      skipped: false,
      changes: ["task-imported"],
      warnings: [],
    });
    repairLegacyCronStoreWithoutPrompt.mockResolvedValue({
      changes: ["cron-imported"],
      warnings: [],
    });
    collectCronCodexRuntimePolicyTargetsReadOnly.mockResolvedValue({ targets: [], warnings: [] });
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { mode: "local", port: 19091 } },
      sourceConfig: { gateway: { mode: "local", port: 19091 } },
      parsed: { gateway: { mode: "local", port: 19091 } },
      legacyIssues: [],
      warnings: [],
      issues: [],
    });
  });

  it("clears stale plugin quarantine through the current-checkpoint preflight", async () => {
    setActiveDegradedPlugins([
      {
        pluginId: "stale-plugin",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "missing-main-entry",
          detail: "index.js",
          installPath: "/plugins/stale-plugin",
        },
      },
    ]);
    planStartupPluginConvergence.mockResolvedValueOnce({ required: false, installRecords: {} });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(listActiveDegradedPlugins()).toEqual([]);
    expect(runActivePluginPayloadSmokeCheck).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
  });

  it("blocks gateway readiness when plugin repair warnings remain", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    runPostCorePluginConvergence.mockResolvedValueOnce(
      makeStartupConvergenceResult({
        warnings: [
          {
            reason: "Configured plugin discord is not installed.",
            message: "Configured plugin discord is not installed.",
            guidance: ["Run `openclaw update repair` to retry plugin repair."],
          },
        ],
      }),
    );

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toThrow("Configured plugin discord is not installed");

    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "- Configured plugin discord is not installed. Run `openclaw update repair` to retry plugin repair.",
      "Doctor warnings",
    );
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("quarantines a plugin payload verification failure and checkpoints readiness", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      config: {
        gateway: { mode: "local", port: 19091 },
        plugins: { entries: { discord: { enabled: true } } },
      },
      sourceConfig: {
        gateway: { mode: "local", port: 19091 },
        plugins: { entries: { discord: { enabled: true } } },
      },
      parsed: {
        gateway: { mode: "local", port: 19091 },
        plugins: { entries: { discord: { enabled: true } } },
      },
      legacyIssues: [],
      warnings: [],
      issues: [],
    });
    runPostCorePluginConvergence.mockResolvedValueOnce(
      makeStartupConvergenceResult({
        errored: true,
        warnings: [
          {
            pluginId: "discord",
            reason: "missing-main-entry: index.js",
            message: 'Plugin "discord" failed post-core payload smoke check (missing): index.js',
            guidance: [
              "Run `openclaw update repair` to retry plugin repair.",
              "Run `openclaw plugins inspect discord --runtime --json` for details.",
            ],
          },
        ],
        smokeFailures: [
          {
            pluginId: "discord",
            installPath: "/plugins/discord",
            reason: "missing-main-entry",
            detail: "index.js",
          },
        ],
      }),
    );

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(listActiveDegradedPlugins()).toEqual([
      {
        pluginId: "discord",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "missing-main-entry",
          detail: "index.js",
          installPath: "/plugins/discord",
        },
      },
    ]);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        '- Plugin "discord" failed post-core payload smoke check (missing): index.js',
      ),
      "Doctor warnings",
    );
    expect(note.mock.calls.filter(([, title]) => title === "Doctor warnings")).toHaveLength(1);
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledOnce();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });
});
