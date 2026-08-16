// Task read-command regressions cover fresh shared-state behavior.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTaskRecord } from "../tasks/task-registry.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  tasksAuditCommand,
  tasksListCommand,
  tasksMaintenanceCommand,
  tasksNotifyCommand,
} from "./tasks.js";

function setStateSchemaVersion(databasePath: string, version: number): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA user_version = ${version};
      UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
    `);
  } finally {
    database.close();
  }
}

function readStateSchemaVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  } finally {
    database.close();
  }
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  };
}

describe("task inspection shared-state access", () => {
  it("lists, audits, and previews maintenance without creating the shared database", async () => {
    await withOpenClawTestState(
      { label: "tasks-readonly-state", layout: "state-only", scenario: "minimal" },
      async (state) => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const runtime = createRuntime();

        expect(fs.existsSync(databasePath)).toBe(false);
        await tasksListCommand({ json: true }, runtime);
        expect(fs.existsSync(databasePath)).toBe(false);
        await tasksAuditCommand({ json: true }, runtime);
        expect(fs.existsSync(databasePath)).toBe(false);
        await tasksMaintenanceCommand({ json: true, apply: false }, runtime);

        expect(fs.existsSync(databasePath)).toBe(false);
        expect(runtime.writeJson).toHaveBeenCalledTimes(3);
      },
    );
  });

  it("refuses an old schema during inspection, then lets a mutation migrate", async () => {
    await withOpenClawTestState(
      { label: "tasks-old-schema", layout: "state-only", scenario: "minimal" },
      async (state) => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        const task = createTaskRecord({
          runtime: "cli",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          task: "Exercise old-schema command routing",
        });
        expect(task).toBeTruthy();
        if (!task) {
          return;
        }

        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        closeOpenClawStateDatabaseForTest();
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const oldVersion = OPENCLAW_STATE_SCHEMA_VERSION - 1;
        setStateSchemaVersion(databasePath, oldVersion);
        const runtime = createRuntime();

        await expect(tasksListCommand({ json: true }, runtime)).rejects.toThrow(
          new RegExp(
            `older schema version ${oldVersion}.*will not migrate it.*openclaw doctor --fix`,
            "u",
          ),
        );
        expect(readStateSchemaVersion(databasePath)).toBe(oldVersion);

        await expect(
          tasksMaintenanceCommand({ json: true, apply: false }, runtime),
        ).rejects.toThrow(/older schema version/u);
        expect(readStateSchemaVersion(databasePath)).toBe(oldVersion);

        await tasksNotifyCommand({ lookup: task.taskId, notify: "state_changes" }, runtime);

        expect(runtime.error).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(readStateSchemaVersion(databasePath)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      },
    );
  });
});
