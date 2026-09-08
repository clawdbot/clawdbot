import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "./openclaw-state-db-cache.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

function createOptions(stateDir: string) {
  return {
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    path: path.join(stateDir, "state", "openclaw.sqlite"),
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("artifact-preserving shared-state reads", () => {
  it.each([
    ["cached", "sync"],
    ["cached", "async"],
    ["uncached", "sync"],
    ["uncached", "async"],
  ] as const)(
    "reads committed rows without joining a %s transaction (%s)",
    async (cacheState, mode) => {
      await withTempDir("openclaw-state-readonly-isolated-", async (stateDir) => {
        const options = createOptions(stateDir);
        const opened = openOpenClawStateDatabase(options);
        opened.db.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original');");
        if (cacheState === "uncached") {
          closeOpenClawStateDatabaseForTest();
        }
        const writer = cacheState === "cached" ? opened.db : new DatabaseSync(options.path);
        writer.exec("BEGIN; UPDATE held SET value = 'uncommitted';");
        try {
          const read =
            mode === "async"
              ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync
              : withExistingOpenClawStateDatabaseArtifactPreservingReadOnly;
          const result = await read(({ db, path: pathname }) => {
            expect(db).not.toBe(writer);
            expect(pathname).toBe(options.path);
            return db.prepare("SELECT value FROM held").all();
          }, options);
          expect(result).toEqual([{ value: "original" }]);
          expect(writer.isTransaction).toBe(true);
          expect(writer.prepare("SELECT value FROM held").all()).toEqual([
            { value: "uncommitted" },
          ]);
        } finally {
          writer.exec("ROLLBACK");
          if (cacheState === "uncached") {
            writer.close();
          }
        }
      });
    },
  );

  it("reuses an idle writable handle without preparing a snapshot", async () => {
    await withTempDir("openclaw-state-readonly-reuse-", async (stateDir) => {
      const options = createOptions(stateDir);
      const opened = openOpenClawStateDatabase(options);
      opened.db.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original');");

      const result = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
        expect(db).toBe(opened.db);
        return db.prepare("SELECT value FROM held").all();
      }, options);
      expect(result).toEqual([{ value: "original" }]);
    });
  });
});

it("reads under its live mutation owner but refuses an unrelated caller", async () => {
  await withOpenClawTestState({ label: "owned-ledger-read" }, async ({ env }) => {
    const options = { env };
    const initial = openOpenClawStateDatabase(options);
    initial.db.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original')");
    const pathname = initial.path;
    const owner = acquireOpenClawStateDatabaseFileExclusion(pathname);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const read = () =>
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
        ({ db }) => db.prepare("SELECT value FROM held").get()?.value,
        options,
      );
    const family = () =>
      Promise.all(
        ["", "-wal", "-shm"].map(async (suffix) => {
          try {
            return await fs.readFile(pathname + suffix);
          } catch (error) {
            if (hasNodeErrorCode(error, "ENOENT")) {
              return null;
            }
            throw error;
          }
        }),
      );
    let running: Promise<void> | undefined;
    try {
      const before = await family();
      running = owner.mutate(owner.assertCurrent, async () => {
        expect(await read()).toBe("original");
        expect(await family()).toEqual(before);
        entered.resolve();
        await resume.promise;
        owner.assertCurrent();
        const opened = openOpenClawStateDatabase(options);
        opened.db.exec("BEGIN; UPDATE held SET value = 'uncommitted'");
        try {
          await expect(read()).rejects.toThrow(/outside a transaction/);
          expect(opened.db.isTransaction).toBe(true);
          expect(opened.db.prepare("SELECT value FROM held").get()?.value).toBe("uncommitted");
        } finally {
          opened.db.exec("ROLLBACK");
        }
        expect(await read()).toBe("original");
      });
      await Promise.race([entered.promise, running]);
      await expect(read()).rejects.toThrow(/state-handles/);
      expect(await family()).toEqual(before);
    } finally {
      resume.resolve();
      try {
        await running;
      } finally {
        owner.release();
      }
    }
    expect(await read()).toBe("original");
  });
});
