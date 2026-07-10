// Doctor config preflight tests cover state migration preflight behavior before config repair.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExitError } from "../runtime.js";

type StateMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

type StartupConvergenceWarning = {
  message: string;
  guidance: string[];
};

type StartupConvergenceResult = {
  changes: string[];
  notices?: StartupConvergenceWarning[];
  warnings: StartupConvergenceWarning[];
  errored: boolean;
  smokeFailures: unknown[];
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
const repairLegacyCronStoreWithoutPrompt = vi.hoisted(() =>
  vi.fn(async () => ({ changes: ["cron-imported"], warnings: [] })),
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

vi.mock("./doctor/cron/index.js", () => ({
  repairLegacyCronStoreWithoutPrompt,
}));

vi.mock("../infra/startup-migration-checkpoint.js", () => ({
  acquireStartupMigrationLease,
  needsStartupMigrationCheckpoint,
  recordSuccessfulStartupMigrations,
}));

vi.mock("../cli/update-cli/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence,
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
    needsStartupMigrationCheckpoint.mockReturnValue(false);
    runPostCorePluginConvergence.mockResolvedValue(makeStartupConvergenceResult());
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
    });
    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      recoverCorruptTargetStore: undefined,
    });
    expect(note).toHaveBeenCalledWith("- cron-imported", "Doctor changes");
    expect(note).toHaveBeenCalledWith("- imported", "Doctor changes");
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

  it("does not acquire the startup migration lease when the checkpoint is current", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(acquireStartupMigrationLease).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
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
    ).rejects.toThrow("refusing to report the gateway ready");

    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("blocks gateway readiness when plugin repair warnings remain", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    runPostCorePluginConvergence.mockResolvedValueOnce(
      makeStartupConvergenceResult({
        warnings: [
          {
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

  it("blocks gateway readiness when plugin convergence reports an error", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    runPostCorePluginConvergence.mockResolvedValueOnce(
      makeStartupConvergenceResult({
        errored: true,
        warnings: [
          {
            message: 'Plugin "discord" failed post-core payload smoke check (missing): index.js',
            guidance: [
              "Run `openclaw update repair` to retry plugin repair.",
              "Run `openclaw plugins inspect discord --runtime --json` for details.",
            ],
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
    ).rejects.toThrow("failed post-core payload smoke check");

    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
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
    });
  });

  it("runs plugin state migrations with resolved legacy config before config repair removes retired paths", async () => {
    const parsedConfig = { $include: "memory-search.json" };
    const resolvedConfig = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: "/custom/memory-{agentId}.sqlite",
              vector: { enabled: false },
            },
          },
        },
        list: [{ id: "main" }],
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
          path: "agents.defaults.memorySearch.store.path",
          message:
            "agents.defaults.memorySearch.store.path is legacy; memory indexes now live in each agent database.",
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
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            memorySearch: {
              store: {
                vector: { enabled: false },
              },
            },
          }),
          list: [{ id: "main" }],
        }),
      }),
    });
    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            memorySearch: {
              store: {
                vector: { enabled: false },
              },
            },
          }),
          list: [{ id: "main" }],
        }),
      }),
      pluginDoctorConfig: resolvedConfig,
      env: process.env,
      recoverCorruptTargetStore: undefined,
    });
  });

  it("keeps plugin state migrations for partially valid legacy config repairs", async () => {
    const resolvedConfig = {
      gateway: { mode: "local", port: "not-a-port" },
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: "/custom/memory-{agentId}.sqlite",
              vector: { enabled: false },
            },
          },
        },
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
          path: "agents.defaults.memorySearch.store.path",
          message:
            "agents.defaults.memorySearch.store.path is legacy; memory indexes now live in each agent database.",
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

  it("limits invalid-config preflight to config-independent state migration", async () => {
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

    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).toHaveBeenCalledWith({ env: process.env });
    expect(note).toHaveBeenCalledWith("- task-imported", "Doctor changes");
  });
});
