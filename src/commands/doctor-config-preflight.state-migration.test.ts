// Doctor config preflight tests cover state migration preflight behavior before config repair.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import type { LegacyConfigIssue } from "../config/types.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import { ExitError } from "../runtime.js";
import {
  makeStartupConvergenceResult,
  stateCheckpointOptions,
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

describe("runDoctorConfigPreflight state migration", () => {
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

  it("forwards config snapshot phase measurement", async () => {
    const measure: ConfigSnapshotReadMeasure = async (_name, run) => await run();

    await runDoctorConfigPreflight({
      migrateState: false,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      measure,
    });

    expect(readConfigFileSnapshot).toHaveBeenCalledWith(expect.objectContaining({ measure }));
  });

  it("measures doctor-owned migration stages", async () => {
    const measuredStages: string[] = [];
    const measure: ConfigSnapshotReadMeasure = async (name, run) => {
      measuredStages.push(name);
      return await run();
    };

    await runDoctorConfigPreflight({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      measure,
    });

    expect(measuredStages).toEqual([
      "doctor.config-preflight.state-migrations-import",
      "doctor.config-preflight.state-dir-migrations",
      "doctor.config-preflight.config-snapshot",
      "doctor.config-preflight.cron-repair-import",
      "doctor.config-preflight.cron-repair",
      "doctor.config-preflight.legacy-state-migrations",
    ]);
  });

  it("measures current-checkpoint plugin verification stages", async () => {
    const measuredStages: string[] = [];
    const measure: ConfigSnapshotReadMeasure = async (name, run) => {
      measuredStages.push(name);
      return await run();
    };
    needsStartupMigrationCheckpoint.mockReturnValue(false);

    await runDoctorConfigPreflight({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      measure,
    });

    expect(measuredStages).toEqual([
      "doctor.config-preflight.startup-checkpoint-import",
      "doctor.config-preflight.pristine-state-plan-import",
      "doctor.config-preflight.pristine-state-plan",
      "doctor.config-preflight.config-snapshot",
      "doctor.config-preflight.plugin-plan-import",
      "doctor.config-preflight.plugin-plan",
      "doctor.config-preflight.plugin-payload-verification-import",
      "doctor.config-preflight.plugin-payload-verification",
    ]);
  });

  it.each([
    { name: "uses a current state checkpoint", needed: false, warnings: [] as string[] },
    { name: "records clean state-only completion", needed: true, warnings: [] as string[] },
    { name: "leaves the checkpoint stale after a warning", needed: true, warnings: ["warning"] },
  ])("$name", async ({ needed, warnings }) => {
    vi.clearAllMocks();
    needsStateMigrationCheckpoint.mockReturnValue(needed);
    autoMigrateLegacyStateDir.mockResolvedValue({
      migrated: false,
      skipped: false,
      changes: [],
      warnings,
    });

    await expect(runDoctorConfigPreflight(stateCheckpointOptions)).resolves.toBeDefined();

    expect(autoMigrateLegacyState).toHaveBeenCalledTimes(needed ? 1 : 0);
    expect(planStartupPluginConvergence).not.toHaveBeenCalled();
    if (needed && warnings.length === 0) {
      expect(recordSuccessfulStateMigrations).toHaveBeenCalledWith({
        env: acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env,
        identity: expectMigrationIdentity(),
        lease: startupMigrationLease,
      });
    } else {
      expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
    }
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledTimes(needed ? 1 : 0);
  });

  it("persists a derived plugin index before recording the state checkpoint", async () => {
    const snapshot = await readConfigFileSnapshot();
    readConfigFileSnapshot.mockClear();
    const index = { plugins: [{ pluginId: "legacy-plugin" }] };
    readConfigFileSnapshotWithPluginMetadata
      .mockResolvedValueOnce({
        snapshot,
        pluginMetadataSnapshot: {
          configFingerprint: "plugin-migrations",
          index,
          registrySource: "derived",
        },
      })
      .mockResolvedValueOnce({
        snapshot,
        pluginMetadataSnapshot: {
          configFingerprint: "plugin-migrations",
          index,
          registrySource: "derived",
        },
      })
      .mockResolvedValueOnce({
        snapshot,
        pluginMetadataSnapshot: {
          configFingerprint: "plugin-migrations",
          index,
          registrySource: "derived",
        },
      })
      .mockResolvedValueOnce({
        snapshot,
        pluginMetadataSnapshot: {
          configFingerprint: "plugin-migrations",
          index,
          registrySource: "persisted",
        },
      });
    needsStateMigrationCheckpoint.mockReturnValue(true);

    await runDoctorConfigPreflight(stateCheckpointOptions);

    const pinnedEnv = acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env;
    expect(writePersistedInstalledPluginIndexWithLeaseSync).toHaveBeenCalledWith(index, {
      env: pinnedEnv,
      lease: startupMigrationLease,
    });
    const writeOrder =
      writePersistedInstalledPluginIndexWithLeaseSync.mock.invocationCallOrder[0] ?? 0;
    const verificationReadOrder =
      readConfigFileSnapshotWithPluginMetadata.mock.invocationCallOrder[3] ?? 0;
    expect(verificationReadOrder).toBeGreaterThan(writeOrder);
    expect(readConfigFileSnapshotWithPluginMetadata.mock.calls[3]?.[0]).toEqual({
      allowCurrentPluginMetadata: false,
    });
    const checkpointOrder = recordSuccessfulStateMigrations.mock.invocationCallOrder[0] ?? 0;
    expect(checkpointOrder).toBeGreaterThan(verificationReadOrder);
    expect(recordSuccessfulStateMigrations).toHaveBeenCalledWith({
      env: pinnedEnv,
      identity: expectMigrationIdentity(),
      lease: startupMigrationLease,
    });
    expect(autoMigrateLegacyState).toHaveBeenCalledOnce();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("runs the startup guard immediately before the first state mutation", async () => {
    const beforeStateMigrations = vi.fn<(_snapshot?: unknown) => Promise<boolean>>(
      async () => true,
    );

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      beforeStateMigrations,
    });

    expect(beforeStateMigrations).toHaveBeenCalledTimes(2);
    const guardOrder = beforeStateMigrations.mock.invocationCallOrder[0] ?? 0;
    const firstMutationOrder = autoMigrateLegacyStateDir.mock.invocationCallOrder[0] ?? 0;
    expect(firstMutationOrder).toBeGreaterThan(guardOrder);
    const configGuardOrder = beforeStateMigrations.mock.invocationCallOrder[1] ?? 0;
    const configMutationOrder = repairLegacyCronStoreWithoutPrompt.mock.invocationCallOrder[0] ?? 0;
    expect(configMutationOrder).toBeGreaterThan(configGuardOrder);
    expect(beforeStateMigrations.mock.calls[1]?.[0]).toMatchObject({
      valid: true,
      sourceConfig: { gateway: { mode: "local", port: 19091 } },
    });
  });

  it("skips every state migration stage when the startup guard rejects", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      beforeStateMigrations: async () => false,
    });

    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).toHaveBeenCalledOnce();
  });

  it("does not touch the startup checkpoint before the startup guard accepts", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        beforeStateMigrations: async () => false,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toThrow("selected config changed during startup");

    expect(needsStartupMigrationCheckpoint).not.toHaveBeenCalled();
    expect(acquireStartupMigrationLeaseWithWait).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("releases the startup lease when the fresh config guard rejects", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-original-state";
    let leaseEnv: NodeJS.ProcessEnv | undefined;
    acquireStartupMigrationLeaseWithWait.mockImplementationOnce(async ({ env }) => {
      leaseEnv = env;
      return {
        ...startupMigrationLease,
        release: vi.fn(() => {
          expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-original-state");
          startupMigrationLeaseRelease();
        }),
      };
    });
    const beforeStateMigrations = vi
      .fn<(_snapshot?: Record<string, unknown>) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-drifted-state";
        return false;
      });

    try {
      await expect(
        runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          beforeStateMigrations,
          requireStartupMigrationCheckpoint: true,
        }),
      ).rejects.toThrow("selected config changed during startup");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }

    expect(leaseEnv).not.toBe(process.env);
    expect(beforeStateMigrations).toHaveBeenCalledTimes(2);
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("releases the startup lease before propagating a deferred service exit", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    const deferredExit = new ExitError(78);
    const beforeStateMigrations = vi
      .fn<(_snapshot?: Record<string, unknown>) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(deferredExit);

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        beforeStateMigrations,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toBe(deferredExit);

    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("skips config-dependent migrations when the fresh snapshot guard rejects", async () => {
    const beforeStateMigrations = vi
      .fn<(snapshot?: Record<string, unknown>) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      beforeStateMigrations,
    });

    expect(autoMigrateLegacyStateDir).toHaveBeenCalledOnce();
    expect(beforeStateMigrations).toHaveBeenCalledTimes(2);
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
  });

  it("runs full state migrations after reading the config snapshot", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(autoMigrateLegacyStateDir).toHaveBeenCalledOnce();
    expect(readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      migrateCodexModelRefs: false,
    });
    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      recoverCorruptTargetStore: undefined,
      doctorOnlyStateMigrations: undefined,
    });
    expect(note).toHaveBeenCalledWith("- cron-imported", "Doctor changes");
    expect(note).toHaveBeenCalledWith("- imported", "Doctor changes");
  });

  it("carries cron Codex runtime policy targets only during repair", async () => {
    collectCronCodexRuntimePolicyTargetsReadOnly.mockResolvedValueOnce({
      targets: [{ modelRef: "openai/gpt-5.6-sol" }],
      warnings: [],
    });

    const result = await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      repairPrefixedConfig: true,
    });

    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      migrateCodexModelRefs: false,
    });
    expect(collectCronCodexRuntimePolicyTargetsReadOnly).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
    });
    expect(result.cronCodexRuntimePolicyTargets).toEqual([{ modelRef: "openai/gpt-5.6-sol" }]);
  });

  it("rechecks the checkpoint after acquisition before running migrations", async () => {
    needsStateMigrationCheckpoint.mockReturnValueOnce(true).mockReturnValue(false);
    needsStartupMigrationCheckpoint.mockReturnValueOnce(true).mockReturnValue(false);

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(2);
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("pins startup plugin convergence to the explicit compatibility host version", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    const previousHostVersion = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.7.2-beta.7";

    try {
      await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        requireStartupMigrationCheckpoint: true,
      });
    } finally {
      if (previousHostVersion === undefined) {
        delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
      } else {
        process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = previousHostVersion;
      }
    }

    expect(runPostCorePluginConvergence).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      env: expect.any(Object),
      compatibilityHostVersion: "2026.7.2-beta.7",
      baselineInstallRecords: {},
    });
  });

  it("refuses startup when plugin migration inputs change during convergence", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    pluginMigrationFingerprint
      .mockReturnValueOnce("plugin-migrations-before")
      .mockReturnValueOnce("plugin-migrations-before")
      .mockReturnValueOnce("plugin-migrations-before")
      .mockReturnValueOnce("plugin-migrations-after");

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toThrow("plugin migration inputs changed during startup convergence");

    expect(recordSuccessfulStateMigrations).toHaveBeenCalledWith({
      env: acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env,
      identity: expect.objectContaining({
        pluginMigrationFingerprint: "plugin-migrations-before",
      }),
      lease: startupMigrationLease,
    });
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("records the startup migration checkpoint when state migrations only leave notices", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    autoMigrateLegacyStateDir.mockResolvedValueOnce({
      migrated: true,
      skipped: false,
      changes: [],
      warnings: [],
      notices: ["Left reviewed residue in place."],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    const pinnedEnv = acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env;
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledWith({
      env: pinnedEnv,
      identity: expectMigrationIdentity(),
      lease: startupMigrationLease,
    });
    expect(note).toHaveBeenCalledWith("- Left reviewed residue in place.", "Doctor notices");
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("checkpoints after a dreaming conflict is archived without a migration warning", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    autoMigrateLegacyPluginDoctorState.mockResolvedValueOnce({
      migrated: true,
      skipped: false,
      changes: [
        "Resolved Memory Core session ingestion legacy conflict by keeping canonical SQLite plugin state",
        "Archived Memory Core session ingestion conflicting legacy source",
      ],
      warnings: [],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      skipPristineCoreStateMigrations: true,
    });

    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Resolved Memory Core session ingestion legacy conflict by keeping canonical SQLite plugin state",
      ),
      "Doctor changes",
    );
    expect(note).not.toHaveBeenCalledWith(
      expect.stringContaining("SQLite rows conflict with the legacy source"),
      "Doctor warnings",
    );
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledOnce();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
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

  it("keeps ownerless install-record failures blocking", async () => {
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
      3,
    );
    runPostCorePluginConvergence.mockResolvedValueOnce(
      makeStartupConvergenceResult({
        errored: true,
        warnings: [
          {
            pluginId: "discord",
            reason: "missing-install-path: install path missing",
            message: 'Plugin "discord" has no install path.',
            guidance: ["Run `openclaw update repair` to retry plugin repair."],
          },
        ],
        smokeFailures: [
          {
            pluginId: "discord",
            reason: "missing-install-path",
            detail: "install path missing",
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
    ).rejects.toThrow('Plugin "discord" has no install path.');

    expect(listActiveDegradedPlugins()).toEqual([]);
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
  });

  it("checkpoints startup migrations without loading plugin convergence when the plan is empty", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    planStartupPluginConvergence.mockResolvedValueOnce({ required: false, installRecords: {} });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(planStartupPluginConvergence).toHaveBeenCalledWith({
      config: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
    });
    expect(runPostCorePluginConvergence).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledOnce();
  });

  it("skips legacy migration loading for a prepared pristine state root", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    planStartupPluginConvergence.mockResolvedValueOnce({ required: false, installRecords: {} });
    const beforeStateMigrations = vi.fn(async () => true);

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      skipPristineStartupStateMigrations: true,
      beforeStateMigrations,
    });

    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
    expect(beforeStateMigrations).toHaveBeenNthCalledWith(1);
    expect(beforeStateMigrations).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ valid: true }),
    );
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledOnce();
  });

  it("runs only plugin-owned migrations for a pristine core state root", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    planPristineStartupStateMigrations.mockReturnValueOnce({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: true,
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(autoMigrateLegacyStateDir).toHaveBeenCalledOnce();
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledWith({
      config: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
    });
  });

  it("retains the prepared core-state fact and explicit Doctor repair authority", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      skipPristineCoreStateMigrations: true,
      doctorOnlyStateMigrations: true,
    });

    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledWith({
      config: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      doctorOnlyStateMigrations: true,
    });
  });

  it("blocks gateway readiness when startup migrations leave warnings", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
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
