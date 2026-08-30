import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  snapshotStateFixtureFiles,
  writeStateSchemaFixture,
} from "../test-utils/state-schema-fixture.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  readOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

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

const {
  assertOpenClawStateDatabaseCompatible,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
} = await import("./openclaw-state-db-readonly.js");
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

describe("shared-state compatibility admission", () => {
  it("leaves missing state absent", async () => {
    await withTempDir("openclaw-state-compatible-missing-", async (root) => {
      const stateDir = path.join(root, "missing");
      await expect(assertOpenClawStateDatabaseCompatible(createOptions(stateDir))).resolves.toBe(
        undefined,
      );
      expect(await fs.readdir(root)).toEqual([]);
    });
  });

  it.each([OPENCLAW_STATE_SCHEMA_VERSION - 1, OPENCLAW_STATE_SCHEMA_VERSION])(
    "admits schema %i without initializing or repairing it",
    async (schemaVersion) => {
      await withTempDir("openclaw-state-compatible-existing-", async (stateDir) => {
        await writeStateSchemaFixture(stateDir, schemaVersion);
        const before = await snapshotStateFixtureFiles(stateDir);

        await assertOpenClawStateDatabaseCompatible(createOptions(stateDir));

        expect(await snapshotStateFixtureFiles(stateDir)).toEqual(before);
      });
    },
  );

  it.each([false, true])(
    "rejects a future schema without touching artifacts (quarantined=%s)",
    async (quarantined) => {
      await withTempDir("openclaw-state-compatible-future-", async (stateDir) => {
        const databasePath = await writeStateSchemaFixture(stateDir);
        const options = createOptions(stateDir);
        if (quarantined) {
          expect(
            recordOpenClawDatabaseQuarantine({
              env: options.env,
              kind: "state",
              path: databasePath,
              reason: "repair still required",
            }),
          ).toBe(true);
        }
        const before = await snapshotStateFixtureFiles(stateDir);

        await expect(assertOpenClawStateDatabaseCompatible(options)).rejects.toMatchObject({
          name: "SqliteSchemaVersionError",
        });

        expect(await snapshotStateFixtureFiles(stateDir)).toEqual(before);
      });
    },
  );

  it("reads a future version committed only in WAL without changing the live file family", async () => {
    await withTempDir("openclaw-state-compatible-wal-", async (stateDir) => {
      const databasePath = await writeStateSchemaFixture(stateDir, OPENCLAW_STATE_SCHEMA_VERSION);
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
        `);
        const before = await snapshotStateFixtureFiles(stateDir);
        expect(before.map((entry) => entry.path)).toContain(
          path.join("state", "openclaw.sqlite-wal"),
        );

        await expect(
          assertOpenClawStateDatabaseCompatible(createOptions(stateDir)),
        ).rejects.toMatchObject({ name: "SqliteSchemaVersionError" });

        expect(await snapshotStateFixtureFiles(stateDir)).toEqual(before);
      } finally {
        database.close();
      }
    });
  });

  it("leaves compatible quarantine decisions for explicit Doctor repair", async () => {
    await withTempDir("openclaw-state-compatible-quarantine-", async (stateDir) => {
      const databasePath = await writeStateSchemaFixture(stateDir, OPENCLAW_STATE_SCHEMA_VERSION);
      const options = createOptions(stateDir);
      expect(
        recordOpenClawDatabaseQuarantine({
          env: options.env,
          kind: "state",
          path: databasePath,
          reason: "repair still required",
        }),
      ).toBe(true);
      const before = await snapshotStateFixtureFiles(stateDir);

      await assertOpenClawStateDatabaseCompatible(options);

      expect(readOpenClawDatabaseQuarantine(databasePath, options)).toMatchObject({
        reason: "repair still required",
      });
      expect(await snapshotStateFixtureFiles(stateDir)).toEqual(before);
    });
  });
});
