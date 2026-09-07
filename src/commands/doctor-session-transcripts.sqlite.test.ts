// Doctor session transcript tests cover transcript inspection and repair guidance.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedPostSessionPluginMigration } from "../infra/state-migrations.types.js";

const note = vi.hoisted(() => vi.fn());
const repairReservedIncognitoSessionKeys = vi.hoisted(() => vi.fn());
const repairCanonicalSessionDeliveryStates = vi.hoisted(() => vi.fn());
const repairCanonicalSessionResolvedSkills = vi.hoisted(() => vi.fn());
const repairCanonicalSessionKeys = vi.hoisted(() => vi.fn());
const migrateLegacyMainSessionKeys = vi.hoisted(() => vi.fn());
const runDoctorSessionSqlite = vi.hoisted(() => vi.fn());
const withDoctorSqliteMaintenanceLock = vi.hoisted(() => vi.fn());
const runPostSessionPluginDoctorStateRepairs = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("./doctor-session-sqlite.js", () => ({
  runDoctorSessionSqlite,
}));

vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  runPostSessionPluginDoctorStateRepairs,
}));

vi.mock("./doctor-session-incognito-key-repair.js", () => ({
  repairReservedIncognitoSessionKeys,
}));

vi.mock("./doctor-session-delivery-state.js", () => ({
  repairCanonicalSessionDeliveryStates,
  repairCanonicalSessionResolvedSkills,
}));

vi.mock("./doctor-session-exec-policy.js", () => ({
  repairLegacySessionExecPolicy: vi.fn(),
}));

vi.mock("./doctor-session-canonical-keys.js", () => ({
  repairCanonicalSessionKeys,
}));

vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys,
}));

vi.mock("./doctor-sqlite-maintenance-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-sqlite-maintenance-lock.js")>();
  return {
    ...actual,
    withDoctorSqliteMaintenanceLock,
  };
});

import { GatewayLockError } from "../infra/gateway-lock.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";
import { DoctorSqliteMaintenanceLockUnavailableError } from "./doctor-sqlite-maintenance-lock.js";

function emptySessionSqliteReport() {
  return {
    totals: {
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 0,
      sqliteEntries: 0,
      unreferencedJsonlFiles: 0,
      validatedTranscriptEvents: 0,
    },
  };
}

const preparedPostSessionPluginMigration: PreparedPostSessionPluginMigration = {
  step: {
    id: "plugin-doctor-post-session-state",
    phase: "final",
    source: [{ kind: "owner", id: "plugin:acpx:acpx-session-owner-resources" }],
    target: [{ kind: "owner", id: "plugin:acpx:doctor-state" }],
    requiredness: "conditional",
    reversibility: "checkpoint-required",
  },
  plannedActions: [{ pluginId: "acpx", id: "acpx-session-owner-resources" }],
};

describe("doctor session transcript repair", () => {
  let root: string;

  beforeEach(async () => {
    note.mockClear();
    repairReservedIncognitoSessionKeys.mockReset().mockReturnValue({ found: 0, repaired: 0 });
    repairCanonicalSessionDeliveryStates
      .mockReset()
      .mockReturnValue({ found: 0, repaired: 0, scannedStores: 0 });
    repairCanonicalSessionResolvedSkills
      .mockReset()
      .mockReturnValue({ found: 0, repaired: 0, scannedStores: 0 });
    repairCanonicalSessionKeys.mockReset().mockResolvedValue({
      archivedTranscriptDirectories: [],
      foundGroups: 0,
      repairBatches: 0,
      removedRows: 0,
      repairedGroups: 0,
      scannedStores: 0,
    });
    migrateLegacyMainSessionKeys.mockReset().mockResolvedValue({
      armed: false,
      changes: [],
      complete: false,
      ledgerComplete: false,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [{ kind: "not-armed" }],
      warnings: [],
    });
    runDoctorSessionSqlite.mockReset();
    runPostSessionPluginDoctorStateRepairs
      .mockReset()
      .mockResolvedValue({ changes: [], warnings: [] });
    withDoctorSqliteMaintenanceLock
      .mockReset()
      .mockImplementation(
        async (params: { run: (authority: { assertCurrent(): void }) => unknown }) =>
          await params.run({ assertCurrent() {} }),
      );
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-")),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("runs session SQLite import through the public doctor repair path", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    runDoctorSessionSqlite.mockResolvedValueOnce({
      totals: {
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedTranscriptEvents: 2,
        issues: 0,
        legacyEntries: 1,
        sqliteEntries: 1,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const cfg = {};

    await noteSessionTranscriptHealth({
      cfg,
      env,
      sessionDirs: [sessionsDir],
      sessionSqlite: true,
      shouldRepair: true,
    });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      cfg,
      env,
      mode: "import",
    });
    expect(migrateLegacyMainSessionKeys).toHaveBeenCalledWith({
      cfg,
      env,
      mode: "doctor-fix",
    });
    expect(repairReservedIncognitoSessionKeys).toHaveBeenCalledWith({ apply: true, cfg, env });
    expect(repairCanonicalSessionResolvedSkills).toHaveBeenCalledWith({ apply: true, cfg, env });
    expect(
      expectDefined(runDoctorSessionSqlite.mock.invocationCallOrder[0], "SQLite import call order"),
    ).toBeLessThan(
      expectDefined(
        migrateLegacyMainSessionKeys.mock.invocationCallOrder[0],
        "legacy-main session migration call order",
      ),
    );
    expect(
      expectDefined(
        migrateLegacyMainSessionKeys.mock.invocationCallOrder[0],
        "legacy-main session migration call order",
      ),
    ).toBeLessThan(
      expectDefined(
        repairCanonicalSessionKeys.mock.invocationCallOrder[0],
        "canonical session repair call order",
      ),
    );
    expect(
      expectDefined(
        repairCanonicalSessionKeys.mock.invocationCallOrder[0],
        "canonical session repair call order",
      ),
    ).toBeLessThan(
      expectDefined(
        repairCanonicalSessionResolvedSkills.mock.invocationCallOrder[0],
        "runtime-only skills repair call order",
      ),
    );
    expect(
      expectDefined(
        repairCanonicalSessionResolvedSkills.mock.invocationCallOrder[0],
        "runtime-only skills repair call order",
      ),
    ).toBeLessThan(
      expectDefined(
        repairReservedIncognitoSessionKeys.mock.invocationCallOrder[0],
        "reserved key repair call order",
      ),
    );
    expect(
      expectDefined(
        repairCanonicalSessionDeliveryStates.mock.invocationCallOrder[0],
        "delivery state repair call order",
      ),
    ).toBeLessThan(
      expectDefined(
        runPostSessionPluginDoctorStateRepairs.mock.invocationCallOrder[0],
        "post-session plugin repair call order",
      ),
    );
    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenCalledWith({
      config: cfg,
      env,
      maintenanceAuthority: { assertCurrent: expect.any(Function) },
    });
    expect(withDoctorSqliteMaintenanceLock).toHaveBeenCalledWith({
      env,
      operation: "session SQLite import",
      run: expect.any(Function),
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Legacy entries: 1"),
      "Session SQLite",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Archived 2 legacy transcript artifact(s)."),
      "Session SQLite",
    );
  });

  it("hands a large untouched original to public Doctor SQLite import without a raw repair copy", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "large.jsonl");
    await fs.writeFile(transcriptPath, '{"type":"session","id":"large","version":3}\n');
    const payload = "x".repeat(64 * 1024);
    for (let index = 0; index < 128; index += 1) {
      await fs.appendFile(
        transcriptPath,
        `${JSON.stringify({
          type: "message",
          id: `event-${index}`,
          parentId: index ? `event-${index - 1}` : null,
          message: { role: "assistant", provider: "openai-codex", content: payload },
        })}\n`,
      );
    }
    const originalSize = (await fs.stat(transcriptPath)).size;
    let filesAtImport: string[] = [];
    let sizeAtImport = 0;
    runDoctorSessionSqlite.mockImplementationOnce(async () => {
      filesAtImport = await fs.readdir(sessionsDir);
      sizeAtImport = (await fs.stat(transcriptPath)).size;
      return { totals: { legacyEntries: 0, unreferencedJsonlFiles: 0, issues: 0 } };
    });
    const readFile = vi.spyOn(fs, "readFile");
    try {
      await noteSessionTranscriptHealth({
        cfg: {},
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        sessionDirs: [sessionsDir],
        sessionSqlite: true,
        shouldRepair: true,
      });
      expect({
        filesAtImport,
        sizeAtImport,
        fullRawRead: readFile.mock.calls.some(([file]) => file === transcriptPath),
      }).toEqual({
        filesAtImport: ["large.jsonl"],
        sizeAtImport: originalSize,
        fullRawRead: false,
      });
    } finally {
      readFile.mockRestore();
    }
  });

  it("explains how to shrink SQLite files after removing persisted runtime skills", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    runDoctorSessionSqlite.mockResolvedValueOnce({
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedTranscriptEvents: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 2,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    repairCanonicalSessionResolvedSkills.mockReturnValueOnce({
      found: 2,
      repaired: 2,
      scannedStores: 1,
    });

    await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      sessionDirs: [sessionsDir],
      sessionSqlite: true,
      shouldRepair: true,
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Logical SQLite pages are freed"),
      "Session SQLite",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        'shrinking the on-disk database requires "openclaw doctor --session-sqlite compact --session-sqlite-all-agents"',
      ),
      "Session SQLite",
    );
  });

  it("keeps session SQLite dry-run read-only without taking maintenance ownership", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    runDoctorSessionSqlite.mockResolvedValueOnce({
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedTranscriptEvents: 0,
        issues: 1,
        legacyEntries: 1,
        sqliteEntries: 0,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const cfg = {};

    await noteSessionTranscriptHealth({
      cfg,
      env,
      sessionDirs: [sessionsDir],
      sessionSqlite: true,
      shouldRepair: false,
    });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      cfg,
      env,
      mode: "dry-run",
    });
    expect(migrateLegacyMainSessionKeys).toHaveBeenCalledWith({ cfg, env, mode: "detect" });
    expect(withDoctorSqliteMaintenanceLock).not.toHaveBeenCalled();
    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenCalledWith({
      config: cfg,
      env,
      maintenanceAuthority: undefined,
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        'Inspect with "openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents".',
      ),
      "Session SQLite",
    );
  });

  it("reports post-session plugin changes and actionable ownership warnings", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    runDoctorSessionSqlite.mockResolvedValueOnce({
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedTranscriptEvents: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 0,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    runPostSessionPluginDoctorStateRepairs.mockResolvedValueOnce({
      changes: ["Removed 2 orphaned plugin session bindings"],
      warnings: ["Plugin lifecycle ownership unavailable; rerun openclaw doctor --fix"],
    });

    const receipts: unknown[] = [];
    const receipt = await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      sessionDirs: [sessionsDir],
      sessionSqlite: true,
      shouldRepair: true,
      postSessionPluginMigration: preparedPostSessionPluginMigration,
      onStepReceipt: (entry) => receipts.push(entry),
    });

    expect(receipt).toMatchObject({
      ...preparedPostSessionPluginMigration.step,
      changes: ["Removed 2 orphaned plugin session bindings"],
      outcome: "refused",
      refusal: { code: "step-refused" },
    });
    expect(receipts).toEqual([receipt]);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Removed 2 orphaned plugin session bindings"),
      "Plugin session repair",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("rerun openclaw doctor --fix"),
      "Plugin session repair",
    );
  });

  it("passes frozen post-session actions to the writer and records mutation before receipt", async () => {
    runDoctorSessionSqlite.mockResolvedValue(emptySessionSqliteReport());
    let mutations = 0;
    runPostSessionPluginDoctorStateRepairs
      .mockImplementationOnce(async () => {
        mutations += 1;
        return { changes: ["repaired frozen plugin action"], warnings: [] };
      })
      .mockResolvedValueOnce({ changes: [], warnings: [] });
    const receipts: unknown[] = [];
    const recordReceipt = (receipt: unknown) => {
      expect(mutations).toBe(1);
      receipts.push(receipt);
    };
    const params = {
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      sessionSqlite: true,
      shouldRepair: true,
      postSessionPluginMigration: preparedPostSessionPluginMigration,
      onStepReceipt: recordReceipt,
    };

    const first = await noteSessionTranscriptHealth(params);
    const replay = await noteSessionTranscriptHealth(params);

    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenNthCalledWith(1, {
      config: {},
      env: params.env,
      maintenanceAuthority: { assertCurrent: expect.any(Function) },
      plannedActions: preparedPostSessionPluginMigration.plannedActions,
    });
    expect(first).toMatchObject({
      id: "plugin-doctor-post-session-state",
      outcome: "completed",
      changes: ["repaired frozen plugin action"],
    });
    expect(replay).toMatchObject({
      id: "plugin-doctor-post-session-state",
      outcome: "skipped",
      changes: [],
    });
    expect(receipts).toEqual([first, replay]);
  });

  it("records a refused post-session receipt when the writer fails", async () => {
    runDoctorSessionSqlite.mockResolvedValue(emptySessionSqliteReport());
    runPostSessionPluginDoctorStateRepairs.mockRejectedValueOnce(new Error("writer failed"));
    const receipts: unknown[] = [];

    const receipt = await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      sessionSqlite: true,
      shouldRepair: true,
      postSessionPluginMigration: preparedPostSessionPluginMigration,
      onStepReceipt: (entry) => receipts.push(entry),
    });

    expect(receipt).toMatchObject({
      id: "plugin-doctor-post-session-state",
      outcome: "refused",
      changes: [],
      refusal: { code: "step-threw" },
    });
    expect(receipts).toEqual([receipt]);
    expect(receipts).not.toContainEqual(expect.objectContaining({ outcome: "completed" }));
  });

  it("closes the planned post-session step when repair is not authorized", async () => {
    runDoctorSessionSqlite.mockResolvedValue(emptySessionSqliteReport());
    const receipts: unknown[] = [];

    const receipt = await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      sessionSqlite: true,
      shouldRepair: false,
      postSessionPluginMigration: preparedPostSessionPluginMigration,
      onStepReceipt: (entry) => receipts.push(entry),
    });

    expect(runPostSessionPluginDoctorStateRepairs).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      id: "plugin-doctor-post-session-state",
      outcome: "refused",
      changes: [],
      refusal: { code: "repair-not-authorized" },
    });
    expect(receipts).toEqual([receipt]);
    expect(receipts).not.toContainEqual(expect.objectContaining({ outcome: "completed" }));
  });

  it.each([false, true])(
    "skips a not-required post-session step with repair %s",
    async (shouldRepair) => {
      runDoctorSessionSqlite.mockResolvedValue(emptySessionSqliteReport());
      const step: PreparedPostSessionPluginMigration["step"] = {
        ...preparedPostSessionPluginMigration.step,
        source: [],
        target: [],
        requiredness: "not-required",
        reversibility: "not-applicable",
      };
      const receipts: unknown[] = [];
      const receipt = await noteSessionTranscriptHealth({
        cfg: { plugins: { enabled: false } },
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        sessionSqlite: true,
        shouldRepair,
        postSessionPluginMigration: { step, plannedActions: [] },
        onStepReceipt: (entry) => receipts.push(entry),
      });
      expect(receipt).toEqual({ ...step, outcome: "skipped", changes: [], warnings: [] });
      expect(receipts).toEqual([receipt]);
      expect(runPostSessionPluginDoctorStateRepairs.mock.calls.length).toBe(0);
    },
  );

  it("does not fall back to dynamic plugin repair after the bound plan refused", async () => {
    runDoctorSessionSqlite.mockResolvedValue(emptySessionSqliteReport());
    const receipts: unknown[] = [];

    await noteSessionTranscriptHealth({
      cfg: { plugins: { entries: { external: { enabled: true } } } },
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      sessionSqlite: true,
      shouldRepair: true,
      postSessionPluginMigrationPlanBound: true,
      onStepReceipt: (receipt) => receipts.push(receipt),
    });

    expect(runPostSessionPluginDoctorStateRepairs).not.toHaveBeenCalled();
    expect(receipts).toEqual([]);
  });

  it("skips session SQLite import when the Gateway owns the state lock", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    withDoctorSqliteMaintenanceLock.mockRejectedValueOnce(
      new DoctorSqliteMaintenanceLockUnavailableError(
        "session SQLite import",
        new GatewayLockError("gateway already running"),
      ),
    );

    await expect(
      noteSessionTranscriptHealth({
        cfg: {},
        env,
        sessionSqlite: true,
        shouldRepair: true,
      }),
    ).resolves.toBeUndefined();

    expect(runDoctorSessionSqlite).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Skipped: Gateway or another SQLite maintenance command owns the state directory",
      ),
      "Session SQLite",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('run "openclaw doctor --fix" for session-store maintenance'),
      "Session SQLite",
    );
  });

  it("keeps non-lock session SQLite import failures fatal", async () => {
    runDoctorSessionSqlite.mockRejectedValueOnce(new Error("SQLite import failed"));
    const receipts: unknown[] = [];

    await expect(
      noteSessionTranscriptHealth({
        cfg: {},
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        sessionSqlite: true,
        shouldRepair: true,
        postSessionPluginMigration: preparedPostSessionPluginMigration,
        onStepReceipt: (receipt) => receipts.push(receipt),
      }),
    ).rejects.toThrow("SQLite import failed");
    expect(runPostSessionPluginDoctorStateRepairs).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      expect.objectContaining({
        id: "plugin-doctor-post-session-state",
        outcome: "refused",
        changes: [],
        refusal: expect.objectContaining({ code: "blocked-by-session-repair-failure" }),
      }),
    ]);
    expect(receipts).not.toContainEqual(
      expect.objectContaining({ outcome: expect.stringMatching(/completed|skipped|warning/) }),
    );
  });
});
