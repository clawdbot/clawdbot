// Agent database permission failures must stay inside the SQLite commit boundary.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    if (chmodFailHook.error) {
      throw chmodFailHook.error;
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  return { ...actual, chmodSync, default: { ...actual, chmodSync } };
});

const {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} = await import("./openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest } = await import("./openclaw-state-db.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent database permission repair", () => {
  afterEach(() => {
    chmodFailHook.error = undefined;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("rolls back an outer write when pre-commit permission repair fails", () => {
    const stateDir = tempDirs.make("openclaw-agent-chmod-");
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    const database = openOpenClawAgentDatabase(options);
    const before = database.db
      .prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get() as { updated_at: number };
    const permissionError = Object.assign(new Error("EACCES: chmod failed"), {
      code: "EACCES",
    });
    chmodFailHook.error = permissionError;

    expect(() =>
      runOpenClawAgentWriteTransaction((writeDatabase) => {
        writeDatabase.db
          .prepare("UPDATE schema_meta SET updated_at = ? WHERE meta_key = 'primary'")
          .run(before.updated_at + 1);
      }, options),
    ).toThrow(permissionError);

    chmodFailHook.error = undefined;
    expect(
      database.db.prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual(before);

    runOpenClawAgentWriteTransaction((writeDatabase) => {
      writeDatabase.db
        .prepare("UPDATE schema_meta SET updated_at = ? WHERE meta_key = 'primary'")
        .run(before.updated_at + 2);
    }, options);
    expect(
      database.db.prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ updated_at: before.updated_at + 2 });
  });
});
