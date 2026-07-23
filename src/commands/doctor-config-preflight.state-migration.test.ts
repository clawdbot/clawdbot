// Doctor config preflight tests cover state migration preflight behavior before config repair.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import { ExitError } from "../runtime.js";

type StateMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

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
const needsStartupMigrationCheckpoint = vi.hoisted(() => vi.fn(() => false));
const startupMigrationLeaseHeartbeat = vi.hoisted(() => vi.fn());
const startupMigrationLeaseRelease = vi.hoisted(() => vi.fn());
const startupMigrationLease = vi.hoisted(() => ({
  heartbeat: startupMigrationLeaseHeartbeat,
  owner: "startup-test-owner",
  release: startupMigrationLeaseRelease,
}));
const acquireStartupMigrationLease = vi.hoisted(() =>
  vi.fn((_params: { env: NodeJS.ProcessEnv }) => startupMigrationLease),
);
const recordSuccessfulStartupMigrations = vi.hoisted(() => vi.fn());
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
const note = vi.hoisted(() => vi.fn());

vi.mock("./doctor-state-migrations.js", () => ({
  autoMigrateLegacyState,
  autoMigrateLegacyStateDir,
  autoMigrateLegacyPluginDoctorState,
  autoMigrateLegacyTaskStateSidecars,
}));

vi.mock("./doctor/cron/legacy-repair.js", () => ({
  collectCronCodexRuntimePolicyTargetsReadOnly,
  repairLegacyCronStoreWithoutPrompt,
}));

vi.mock("../infra/startup-migration-checkpoint.js", () => ({
  acquireStartupMigrationLease,
  needsStartupMigrationCheckpoint,
  recordSuccessfulStartupMigrations,
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
  recoverConfigFromJsonRootSuffix: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

describe("runDoctorConfigPreflight state migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveDegradedPlugins([]);
    needsStartupMigrationCheckpoint.mockReturnValue(false);
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
    expect(acquireStartupMigrationLease).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("releases the startup lease when the fresh config guard rejects", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-original-state";
    let leaseEnv: NodeJS.ProcessEnv | undefined;
    acquireStartupMigrationLease.mockImplementationOnce(({ env }) => {
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

  it("records the startup migration checkpoint after clean startup migrations", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    const pinnedEnv = acquireStartupMigrationLease.mock.calls[0]?.[0]?.env;
    expect(pinnedEnv).toBeDefined();
    expect(pinnedEnv).not.toBe(process.env);
    expect(needsStartupMigrationCheckpoint).toHaveBeenCalledWith({ env: pinnedEnv });
    expect(runPostCorePluginConvergence).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      baselineInstallRecords: {},
    });
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledWith({
      env: pinnedEnv,
      lease: startupMigrationLease,
    });
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

    const pinnedEnv = acquireStartupMigrationLease.mock.calls[0]?.[0]?.env;
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledWith({
      env: pinnedEnv,
      lease: startupMigrationLease,
    });
    expect(note).toHaveBeenCalledWith("- Left reviewed residue in place.", "Doctor notices");
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("refreshes plugin quarantine without repair when the checkpoint is current", async () => {
    planStartupPluginConvergence.mockResolvedValueOnce({
      required: true,
      installRecords: { discord: { source: "npm", installPath: "/plugins/discord" } },
    });
    runActivePluginPayloadSmokeCheck.mockResolvedValueOnce({
      checked: ["discord"],
      failures: [
        {
          pluginId: "discord",
          installPath: "/plugins/discord",
          reason: "missing-main-entry",
          detail: "index.js",
        },
      ],
    });
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

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(acquireStartupMigrationLease).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
    expect(runPostCorePluginConvergence).not.toHaveBeenCalled();
    expect(runActivePluginPayloadSmokeCheck).toHaveBeenCalledWith({
      cfg: {
        gateway: { mode: "local", port: 19091 },
        plugins: { entries: { discord: { enabled: true } } },
      },
      records: { discord: { source: "npm", installPath: "/plugins/discord" } },
      env: process.env,
    });
    expect(listActiveDegradedPlugins()).toMatchObject([
      {
        pluginId: "discord",
        state: "configured-unavailable",
        diagnostic: { reason: "missing-main-entry" },
      },
    ]);
    expect(readConfigFileSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps ownerless payload failures blocking when the checkpoint is current", async () => {
    planStartupPluginConvergence.mockResolvedValueOnce({
      required: true,
      installRecords: { discord: { source: "npm" } },
    });
    runActivePluginPayloadSmokeCheck.mockResolvedValueOnce({
      checked: ["discord"],
      failures: [
        {
          pluginId: "discord",
          reason: "missing-install-path",
          detail: "Install path is missing from the plugin install record.",
        },
      ],
    });
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

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toThrow("Install path is missing from the plugin install record.");

    expect(runPostCorePluginConvergence).not.toHaveBeenCalled();
    expect(listActiveDegradedPlugins()).toEqual([]);
  });

  it("keeps ownerless install-record failures blocking", async () => {
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

  it("retains the prepared core-state fact after runtime files appear", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      skipPristineCoreStateMigrations: true,
    });

    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledOnce();
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

  it("does not checkpoint startup migrations when the config snapshot is invalid", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: { gateway: { mode: "local", port: "bad" } },
      sourceConfig: { gateway: { mode: "local", port: "bad" } },
      parsed: { gateway: { mode: "local", port: "bad" } },
      legacyIssues: [],
      warnings: [],
      issues: [{ path: "gateway.port", message: "invalid" }],
    });

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

  it("passes explicit corrupt-target recovery to state migrations", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      recoverCorruptTargetStore: true,
    });

    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      recoverCorruptTargetStore: true,
      doctorOnlyStateMigrations: undefined,
    });
  });

  it("passes explicit Doctor-only migration authority only when requested", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      doctorOnlyStateMigrations: true,
    });

    expect(autoMigrateLegacyState).toHaveBeenCalledWith(
      expect.objectContaining({ doctorOnlyStateMigrations: true }),
    );
  });

  it("runs plugin state migrations with resolved legacy config before config repair removes retired paths", async () => {
    const parsedConfig = { $include: "memory-search.json" };
    const resolvedConfig = {
      cron: { webhook: "https://example.invalid/cron-finished" },
      memory: {
        search: {
          store: {
            path: "/custom/memory-{agentId}.sqlite",
            vector: { enabled: false },
          },
        },
      },

      agents: {
        defaults: {},
        entries: { main: {} },
      },
    };
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: resolvedConfig,
      sourceConfig: resolvedConfig,
      parsed: parsedConfig,
      legacyIssues: [
        {
          path: "memory.search.store.path",
          message:
            "memory.search.store.path is legacy; memory indexes now live in each agent database.",
        },
      ],
      warnings: [],
      issues: [],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        cron: expect.objectContaining({ webhook: "https://example.invalid/cron-finished" }),
        memory: expect.objectContaining({
          search: expect.objectContaining({
            store: {
              vector: { enabled: false },
            },
          }),
        }),
        agents: expect.objectContaining({
          defaults: expect.objectContaining({}),
          entries: { main: { default: true } },
        }),
      }),
      migrateCodexModelRefs: false,
    });
    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        memory: expect.objectContaining({
          search: expect.objectContaining({
            store: {
              vector: { enabled: false },
            },
          }),
        }),
        agents: expect.objectContaining({
          defaults: expect.objectContaining({}),
          entries: { main: { default: true } },
        }),
      }),
      pluginDoctorConfig: resolvedConfig,
      env: process.env,
      recoverCorruptTargetStore: undefined,
      doctorOnlyStateMigrations: undefined,
    });
  });

  it("keeps plugin state migrations for partially valid legacy config repairs", async () => {
    const resolvedConfig = {
      gateway: { mode: "local", port: "not-a-port" },
      memory: {
        search: {
          store: {
            path: "/custom/memory-{agentId}.sqlite",
            vector: { enabled: false },
          },
        },
      },

      agents: {
        defaults: {},
        list: [{ id: "main" }],
      },
    };
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: resolvedConfig,
      sourceConfig: resolvedConfig,
      parsed: resolvedConfig,
      legacyIssues: [
        {
          path: "memory.search.store.path",
          message:
            "memory.search.store.path is legacy; memory indexes now live in each agent database.",
        },
      ],
      warnings: [],
      issues: [{ path: "gateway.port", message: "invalid" }],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: process.env,
    });
    expect(autoMigrateLegacyTaskStateSidecars).toHaveBeenCalledWith({ env: process.env });
    expect(note).toHaveBeenCalledWith("- plugin-imported", "Doctor changes");
    expect(note).toHaveBeenCalledWith("- task-imported", "Doctor changes");
  });

  it("runs config-independent state migration for invalid config", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: { cron: { store: "/tmp/legacy-cron.json" } },
      sourceConfig: { cron: { store: "/tmp/legacy-cron.json" } },
      parsed: { cron: { store: "/tmp/legacy-cron.json" } },
      legacyIssues: [],
      warnings: [],
      issues: [{ path: "gateway", message: "invalid" }],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(autoMigrateLegacyState).toHaveBeenCalledOnce();
    const migrationParams = autoMigrateLegacyState.mock.calls[0]?.[0] as
      | {
          cfg?: unknown;
          pluginDoctorConfig?: unknown;
          env?: NodeJS.ProcessEnv;
        }
      | undefined;
    expect(migrationParams?.cfg).not.toHaveProperty("cron.store");
    expect(migrationParams?.pluginDoctorConfig).toEqual({
      cron: { store: "/tmp/legacy-cron.json" },
    });
    expect(migrationParams?.env).toBe(process.env);
    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: migrationParams?.cfg,
      migrateCodexModelRefs: false,
    });
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
  });
});
