import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("shared state runtime schema fence", () => {
  it("latches a newer schema committed under an open cached handle", () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-runtime-schema-") } };
    const initial = openOpenClawStateDatabase(options);
    const external = new DatabaseSync(initial.path);
    try {
      external.exec(`
        BEGIN IMMEDIATE;
        PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
        UPDATE schema_meta
           SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1},
               app_version = 'future-build'
         WHERE meta_key = 'primary';
        COMMIT;
      `);
    } finally {
      external.close();
    }

    let failure: unknown;
    try {
      openOpenClawStateDatabase(options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining(
        `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
      ),
    });
    expect(initial.db.isOpen).toBe(false);
    expect(() => openOpenClawStateDatabase(options)).toThrow(failure);
  });

  it("retains the cached handle after a compatible external data commit", () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-runtime-data-") } };
    const initial = openOpenClawStateDatabase(options);
    const external = new DatabaseSync(initial.path);
    try {
      external.exec(`
        UPDATE schema_meta
           SET updated_at = updated_at + 1
         WHERE meta_key = 'primary';
      `);
    } finally {
      external.close();
    }

    expect(openOpenClawStateDatabase(options)).toBe(initial);
    expect(initial.db.isOpen).toBe(true);
  });
});
