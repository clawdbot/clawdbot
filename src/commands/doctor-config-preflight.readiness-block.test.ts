// Doctor config preflight tests cover state migration preflight behavior before config repair.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyConfigIssue } from "../config/types.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import {
  makeStartupConvergenceResult,
  type StartupConvergenceResult,
  type StartupSmokeFailure,
  type StateMigrationResult,
} from "./doctor-config-preflight.state-migration.test-helpers.js";

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
    async (_params?: unknown): Promise<StateMigrationResult> => ({
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
const migrateLegacyConfigMachineState = vi.hoisted(() =>
  vi.fn(() => ({ changes: [], warnings: [] })),
);
const migrateLegacyMediaPersistence = vi.hoisted(() =>
  vi.fn(() => ({ changes: [], warnings: [] })),
);
const repairLegacyCronStoreWithoutPrompt = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      changes: string[];
      warnings: string[];
      codexRuntimePolicyTargets?: Array<{ modelRef: string }>;
    }> => ({ changes: ["cron-imported"], warnings: [] }),
  ),
);
const collectCronCodexRuntimePolicyTargetsReadOnly = vi.hoisted(() =>
  vi.fn(async () => ({ targets: [] as Array<{ modelRef: string }>, warnings: [] as string[] })),
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
const acquireStartupMigrationLeaseWithWait = vi.hoisted(() =>
  vi.fn(async (_params: { env: NodeJS.ProcessEnv }) => startupMigrationLease),
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
const planPristineStartupStateMigrations = vi.hoisted(() =>
  vi.fn(() => ({
    skipAllStateMigrations: false,
    skipCoreStateMigrations: false,
  })),
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

function queueConfigSnapshot(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  count = 1,
): void {
  for (let index = 0; index < count; index += 1) {
    readConfigFileSnapshot.mockResolvedValueOnce(snapshot);
  }
}

function expectMigrationIdentity(): {
  effectiveConfigFingerprint: unknown;
  pluginDoctorConfigFingerprint: unknown;
  pluginMigrationFingerprint: string;
} {
  return {
    effectiveConfigFingerprint: expect.any(String),
    pluginDoctorConfigFingerprint: expect.any(String),
    pluginMigrationFingerprint: "plugin-migrations",
  };
}

vi.mock("./doctor-state-migrations.js", () => ({
  autoMigrateLegacyState,
  autoMigrateLegacyStateDir,
  autoMigrateLegacyPluginDoctorState,
  autoMigrateLegacyTaskStateSidecars,
  migrateLegacyConfigMachineState,
  migrateLegacyMediaPersistence,
}));

vi.mock("./doctor/cron/legacy-repair.js", () => ({
  collectCronCodexRuntimePolicyTargetsReadOnly,
  repairLegacyCronStoreWithoutPrompt,
}));

vi.mock("../infra/startup-migration-checkpoint.js", () => ({
  acquireStartupMigrationLeaseWithWait,
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

describe("runDoctorConfigPreflight startup readiness blocking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireStartupMigrationLeaseWithWait.mockResolvedValue(startupMigrationLease);
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
    collectCronCodexRuntimePolicyTargetsReadOnly.mockReset();
    collectCronCodexRuntimePolicyTargetsReadOnly.mockResolvedValue({ targets: [], warnings: [] });
  });

  it("blocks gateway readiness when state migration warnings outlive the startup checkpoint", async () => {
    needsStateMigrationCheckpoint.mockReturnValue(true);
    needsStartupMigrationCheckpoint.mockReturnValue(false);
    autoMigrateLegacyStateDir.mockResolvedValueOnce({
      migrated: false,
      skipped: false,
      changes: [],
      warnings: ["Left legacy config health state in place."],
    });

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toThrow(
      "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.",
    );

    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("blocks gateway readiness when startup migrations leave warnings", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    // The uninitialized-target state-dir skip stays in `warnings` (#112395), so this
    // also proves non-equivalent legacy contents cannot checkpoint readiness.
    autoMigrateLegacyStateDir.mockResolvedValueOnce({
      migrated: false,
      skipped: false,
      changes: [],
      warnings: ["State dir migration skipped: target already exists. Remove or merge manually."],
    });

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toThrow(
      "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.",
    );

    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
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

    expect(recordSuccessfulStateMigrations).toHaveBeenCalledWith({
      env: acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env,
      identity: expectMigrationIdentity(),
      lease: startupMigrationLease,
    });
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "- Configured plugin discord is not installed. Run `openclaw update repair` to retry plugin repair.",
      "Doctor warnings",
    );
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("quarantines a plugin payload verification failure and checkpoints readiness", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    queueConfigSnapshot(
      {
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
      },
      4,
    );
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

  it("does not checkpoint startup migrations when the config snapshot is invalid", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    queueConfigSnapshot(
      {
        exists: true,
        valid: false,
        config: { gateway: { mode: "local", port: "bad" } },
        sourceConfig: { gateway: { mode: "local", port: "bad" } },
        parsed: { gateway: { mode: "local", port: "bad" } },
        legacyIssues: [],
        warnings: [],
        issues: [{ path: "gateway.port", message: "invalid" }],
      },
      3,
    );

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toThrow("OpenClaw config is invalid");

    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });
});
