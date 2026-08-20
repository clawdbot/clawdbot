// Startup host-link repair must precede plugin-owned state migration imports.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  startupCheckpointOptions,
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
    async (): Promise<StateMigrationResult> => ({
      migrated: true,
      skipped: false,
      changes: [],
      warnings: [],
    }),
  ),
);
const autoMigrateLegacyPluginDoctorState = vi.hoisted(() =>
  vi.fn(
    async (): Promise<StateMigrationResult> => ({
      migrated: false,
      skipped: false,
      changes: [],
      warnings: [],
    }),
  ),
);
const autoMigrateLegacyTaskStateSidecars = vi.hoisted(() =>
  vi.fn(
    async (): Promise<StateMigrationResult> => ({
      migrated: false,
      skipped: false,
      changes: [],
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
  vi.fn(async () => ({ changes: [], warnings: [] })),
);
const collectCronCodexRuntimePolicyTargetsReadOnly = vi.hoisted(() =>
  vi.fn(async () => ({ targets: [], warnings: [] })),
);
const maybeRepairPluginOpenClawHostLinks = vi.hoisted(() =>
  vi.fn(
    async (_params: {
      env: NodeJS.ProcessEnv;
      prompter: { shouldRepair: boolean };
    }): Promise<boolean> => false,
  ),
);
const needsStateMigrationCheckpoint = vi.hoisted(() => vi.fn(() => false));
const needsStartupMigrationCheckpoint = vi.hoisted(() => vi.fn(() => false));
const startupMigrationLeaseRelease = vi.hoisted(() => vi.fn());
const startupMigrationLease = vi.hoisted(() => ({
  assertOwnedInTransaction: vi.fn(),
  heartbeat: vi.fn(),
  owner: "startup-test-owner",
  release: startupMigrationLeaseRelease,
}));
const acquireStartupMigrationLeaseWithWait = vi.hoisted(() =>
  vi.fn(async () => startupMigrationLease),
);
const recordSuccessfulStateMigrations = vi.hoisted(() => vi.fn());
const recordSuccessfulStartupMigrations = vi.hoisted(() => vi.fn());
const runStartupUpgradeConvergence = vi.hoisted(() =>
  vi.fn(async () => ({ blockingDiagnostic: null, quarantinedPlugins: [] })),
);
const refreshStartupPluginQuarantine = vi.hoisted(() =>
  vi.fn(async () => ({ blockingDiagnostic: null, quarantinedPlugins: [] })),
);
const formatStartupPluginVerificationFailure = vi.hoisted(() => vi.fn(() => "verification failed"));
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    exists: true,
    valid: true,
    config: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    sourceConfig: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    parsed: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    legacyIssues: [],
    warnings: [],
    issues: [],
  })),
);
const readConfigFileSnapshotWithPluginMetadata = vi.hoisted(() =>
  vi.fn(async () => ({
    snapshot: await readConfigFileSnapshot(),
    pluginMetadataSnapshot: { configFingerprint: pluginMigrationFingerprint() },
  })),
);
const pluginMigrationFingerprint = vi.hoisted(() => vi.fn(() => "plugin-migrations"));
const findDoctorLegacyConfigIssues = vi.hoisted(() => vi.fn(() => []));
const addDoctorLegacyIssues = vi.hoisted(() => vi.fn(<T>(snapshot: T): T => snapshot));
const runWithPluginMetadataSnapshot = vi.hoisted(() =>
  vi.fn((_scope: unknown, run: () => unknown) => run()),
);
const note = vi.hoisted(() => vi.fn());

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

vi.mock("./doctor-plugin-host-links.js", () => ({
  maybeRepairPluginOpenClawHostLinks,
}));

vi.mock("../infra/startup-migration-checkpoint.js", () => ({
  acquireStartupMigrationLeaseWithWait,
  needsStateMigrationCheckpoint,
  needsStartupMigrationCheckpoint,
  recordSuccessfulStateMigrations,
  recordSuccessfulStartupMigrations,
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

vi.mock("./doctor/shared/pristine-startup-state.js", () => ({
  planPristineStartupStateMigrations: vi.fn(() => ({
    skipAllStateMigrations: false,
    skipCoreStateMigrations: false,
  })),
}));

vi.mock("./doctor-config-preflight-plugin-verification.js", () => ({
  formatStartupPluginVerificationFailure,
  refreshStartupPluginQuarantine,
  runStartupUpgradeConvergence,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

describe("startup plugin host-link preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    needsStateMigrationCheckpoint.mockImplementation(() => needsStartupMigrationCheckpoint());
    acquireStartupMigrationLeaseWithWait.mockResolvedValue(startupMigrationLease);
    autoMigrateLegacyState.mockResolvedValue({
      migrated: true,
      skipped: false,
      changes: [],
      warnings: [],
    });
    maybeRepairPluginOpenClawHostLinks.mockResolvedValue(false);
  });

  it("repairs managed host links before plugin state migration", async () => {
    const migrationOrder: string[] = [];
    maybeRepairPluginOpenClawHostLinks.mockImplementationOnce(async ({ env, prompter }) => {
      migrationOrder.push("host-links");
      expect(env).not.toBe(process.env);
      expect(prompter).toEqual({ shouldRepair: true });
      return true;
    });
    autoMigrateLegacyState.mockImplementationOnce(async () => {
      migrationOrder.push("state");
      return { migrated: true, skipped: false, changes: [], warnings: [] };
    });

    await runDoctorConfigPreflight(startupCheckpointOptions);

    expect(migrationOrder).toEqual(["host-links", "state"]);
    expect(maybeRepairPluginOpenClawHostLinks).toHaveBeenCalledWith({
      env: expect.any(Object),
      prompter: { shouldRepair: true },
    });
  });
});
