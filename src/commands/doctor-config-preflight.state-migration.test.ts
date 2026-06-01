import { describe, expect, it, vi } from "vitest";

const autoMigrateLegacyStateDir = vi.hoisted(() =>
  vi.fn(async () => ({ migrated: false, skipped: false, changes: [], warnings: [] })),
);
const autoMigrateLegacyState = vi.hoisted(() =>
  vi.fn(async () => ({ migrated: true, skipped: false, changes: ["imported"], warnings: [] })),
);
const autoMigrateLegacyTaskStateSidecars = vi.hoisted(() =>
  vi.fn(async () => ({ migrated: true, skipped: false, changes: ["task-imported"], warnings: [] })),
);
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    exists: true,
    valid: true,
    config: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    sourceConfig: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    legacyIssues: [] as Array<{ path: string; message: string }>,
    warnings: [] as Array<{ path: string; message: string }>,
    issues: [] as Array<{ path: string; message: string }>,
  })),
);
const note = vi.hoisted(() => vi.fn());

vi.mock("./doctor-state-migrations.js", () => ({
  autoMigrateLegacyState,
  autoMigrateLegacyStateDir,
  autoMigrateLegacyTaskStateSidecars,
}));

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot,
  recoverConfigFromJsonRootSuffix: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

describe("runDoctorConfigPreflight state migration", () => {
  it("runs full state migrations after reading the config snapshot", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(autoMigrateLegacyStateDir).toHaveBeenCalledOnce();
    expect(readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      recoverCorruptTargetStore: undefined,
    });
    expect(note).toHaveBeenCalledWith("- imported", "Doctor changes");
  });

  it("passes explicit corrupt-target recovery to state migrations", async () => {
    vi.clearAllMocks();

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

  it("limits invalid-config preflight to task sidecar migration", async () => {
    vi.clearAllMocks();
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: {},
      sourceConfig: {},
      legacyIssues: [],
      warnings: [],
      issues: [{ path: "gateway", message: "invalid" }],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).toHaveBeenCalledWith({ env: process.env });
    expect(note).toHaveBeenCalledWith("- task-imported", "Doctor changes");
  });
});
