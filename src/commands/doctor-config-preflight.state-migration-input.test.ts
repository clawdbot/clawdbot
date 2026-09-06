import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, LegacyConfigIssue } from "../config/types.js";
import type { StateMigrationResult } from "./doctor-config-preflight.state-migration.test-helpers.js";

const autoMigrateLegacyStateDir = vi.hoisted(() =>
  vi.fn(async (): Promise<StateMigrationResult> => ({
    migrated: false,
    skipped: false,
    changes: [],
    warnings: [],
  })),
);
const autoMigrateLegacyState = vi.hoisted(() =>
  vi.fn(async (_params?: unknown): Promise<StateMigrationResult> => ({
    migrated: true,
    skipped: false,
    changes: ["imported"],
    warnings: [],
  })),
);
const autoMigrateLegacyPluginDoctorState = vi.hoisted(() =>
  vi.fn(async (): Promise<StateMigrationResult> => ({
    migrated: true,
    skipped: false,
    changes: ["plugin-imported"],
    warnings: [],
  })),
);
const autoMigrateLegacyTaskStateSidecars = vi.hoisted(() =>
  vi.fn(async (): Promise<StateMigrationResult> => ({
    migrated: true,
    skipped: false,
    changes: ["task-imported"],
    warnings: [],
  })),
);
const migrateLegacyMediaPersistence = vi.hoisted(() =>
  vi.fn(() => ({ changes: [], warnings: [] })),
);
const migrateLegacyConfigMachineState = vi.hoisted(() =>
  vi.fn(() => ({ changes: ["cron-store-selection-imported"], warnings: [] })),
);
const repairLegacyCronStoreWithoutPrompt = vi.hoisted(() =>
  vi.fn(async () => ({ changes: ["cron-imported"], warnings: [] })),
);
const collectCronCodexRuntimePolicyTargetsReadOnly = vi.hoisted(() =>
  vi.fn(async () => ({ targets: [], warnings: [] })),
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
const findDoctorLegacyConfigIssues = vi.hoisted(() =>
  vi.fn((_raw: unknown, _sourceRaw?: unknown): LegacyConfigIssue[] => []),
);
const addDoctorLegacyIssues = vi.hoisted(() =>
  vi.fn((snapshot: ConfigFileSnapshot): ConfigFileSnapshot => {
    if (!snapshot.exists) {
      return snapshot;
    }
    const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
    const sourceRaw = snapshot.parsed ?? resolvedRaw;
    const legacyIssues = findDoctorLegacyConfigIssues(resolvedRaw, sourceRaw);
    return legacyIssues.length === 0 ? snapshot : { ...snapshot, legacyIssues };
  }),
);
const note = vi.hoisted(() => vi.fn());

vi.mock("../infra/state-migrations.doctor.js", () => ({
  autoMigrateLegacyState,
}));

vi.mock("../infra/state-migrations.state-dir.js", () => ({
  autoMigrateLegacyStateDir,
  autoMigrateLegacyTaskStateSidecars,
}));

vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  autoMigrateLegacyPluginDoctorState,
}));

vi.mock("../infra/state-migrations.config-machine-state.js", () => ({
  migrateLegacyConfigMachineState,
}));

vi.mock("../infra/state-migrations.media-persistence.js", () => ({
  migrateLegacyMediaPersistence,
}));

vi.mock("./doctor/cron/legacy-repair.js", () => ({
  collectCronCodexRuntimePolicyTargetsReadOnly,
  repairLegacyCronStoreWithoutPrompt,
}));

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata: vi.fn(),
  recoverConfigFromJsonRootSuffix: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
}));

vi.mock("./doctor/shared/legacy-config-issues.js", () => ({
  addDoctorLegacyIssues,
  findDoctorLegacyConfigIssues,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

describe("runDoctorConfigPreflight state migration input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findDoctorLegacyConfigIssues.mockReset();
    findDoctorLegacyConfigIssues.mockReturnValue([]);
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

  it("does not skip a retired custom cron partition on a pristine state root", async () => {
    const sourceConfig = {
      gateway: { mode: "local", port: 19091 },
      agents: {
        entries: { ops: {}, research: {} },
        defaults: {
          heartbeat: { agentId: "ops" },
          systemAgent: { agentId: "ops" },
          authInheritance: { agentId: "ops" },
        },
      },
      cron: { store: "/tmp/custom-cron/jobs.json" },
      talk: { agentId: "ops" },
    };
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: sourceConfig,
      sourceConfig,
      parsed: {
        agents: { list: [{ id: "ops", default: true }, { id: "research" }] },
        cron: { store: "/tmp/custom-cron/jobs.json" },
      },
      legacyIssues: [{ path: "cron.store", message: "cron.store is retired" }],
      warnings: [],
      issues: [{ path: "agents.ownership", message: "explicit ownership is required" }],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      skipPristineCoreStateMigrations: true,
    });

    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: { cron: { store: "/tmp/custom-cron/jobs.json" } },
      migrateCodexModelRefs: false,
    });
    expect(migrateLegacyConfigMachineState).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
    });
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalled();
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
          entries: { main: {} },
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
          entries: { main: {} },
        }),
      }),
      pluginDoctorConfig: resolvedConfig,
      env: process.env,
      recoverCorruptTargetStore: undefined,
      doctorOnlyStateMigrations: undefined,
    });
  });

  it("keeps explicit Doctor repair authority for partially valid legacy config", async () => {
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
      doctorOnlyStateMigrations: true,
    });

    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: process.env,
      doctorOnlyStateMigrations: true,
    });
    expect(autoMigrateLegacyTaskStateSidecars).toHaveBeenCalledWith({ env: process.env });
    expect(note).toHaveBeenCalledWith("- plugin-imported", "Doctor changes");
    expect(note).toHaveBeenCalledWith("- task-imported", "Doctor changes");
  });

  it("runs config-independent state migration for invalid config", async () => {
    findDoctorLegacyConfigIssues.mockReturnValueOnce([
      { path: "cron.store", message: "cron.store is legacy." },
    ]);
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
      cfg: expect.objectContaining({ cron: { store: "/tmp/legacy-cron.json" } }),
      migrateCodexModelRefs: false,
    });
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
  });
});
