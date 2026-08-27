import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";

const snapshotMocks = vi.hoisted(() => ({
  isolated: vi.fn(),
  inProcess: vi.fn(),
}));

vi.mock("../infra/sqlite-readonly-location.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-readonly-location.js")>();
  snapshotMocks.isolated.mockImplementation(actual.prepareSqliteReadOnlyLocationSync);
  snapshotMocks.inProcess.mockImplementation(actual.prepareSqliteReadOnlyLocationSyncInProcess);
  return {
    ...actual,
    prepareSqliteReadOnlyLocationSync: snapshotMocks.isolated,
    prepareSqliteReadOnlyLocationSyncInProcess: snapshotMocks.inProcess,
  };
});

const { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } =
  await import("./openclaw-state-db-readonly.js");
const { closeOpenClawStateDatabaseForTest, openOpenClawStateDatabase } =
  await import("./openclaw-state-db.js");

function createOptions(stateDir: string) {
  return {
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    path: path.join(stateDir, "state", "openclaw.sqlite"),
  };
}

beforeEach(() => {
  snapshotMocks.isolated.mockClear();
  snapshotMocks.inProcess.mockClear();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("artifact-preserving shared-state reads", () => {
  it("prepares snapshots in-process when this process has no writable handle", async () => {
    await withTempDir("openclaw-state-readonly-in-process-", async (stateDir) => {
      const options = createOptions(stateDir);
      openOpenClawStateDatabase(options);
      closeOpenClawStateDatabaseForTest();

      expect(
        withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(() => "read", options),
      ).toBe("read");
      expect(snapshotMocks.inProcess).toHaveBeenCalledOnce();
      expect(snapshotMocks.isolated).not.toHaveBeenCalled();
    });
  });

  it("keeps snapshot preparation isolated while a writable handle has a transaction", async () => {
    await withTempDir("openclaw-state-readonly-isolated-", async (stateDir) => {
      const options = createOptions(stateDir);
      const opened = openOpenClawStateDatabase(options);
      opened.db.exec("BEGIN");
      try {
        expect(
          withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(() => "read", options),
        ).toBe("read");
        expect(snapshotMocks.isolated).toHaveBeenCalledOnce();
        expect(snapshotMocks.inProcess).not.toHaveBeenCalled();
      } finally {
        opened.db.exec("ROLLBACK");
      }
    });
  });

  it("reuses an idle writable handle without preparing a snapshot", async () => {
    await withTempDir("openclaw-state-readonly-reuse-", async (stateDir) => {
      const options = createOptions(stateDir);
      openOpenClawStateDatabase(options);

      expect(
        withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(() => "read", options),
      ).toBe("read");
      expect(snapshotMocks.isolated).not.toHaveBeenCalled();
      expect(snapshotMocks.inProcess).not.toHaveBeenCalled();
    });
  });
});
