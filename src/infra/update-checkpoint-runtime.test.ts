import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import { validateUpdateCheckpointPreviousRuntimeDatabase as validate } from "./update-checkpoint-runtime.js";
import { buildCheckpointReaderRuntime } from "./update-checkpoint-runtime.test-support.js";

let root: string;
let previous: Awaited<ReturnType<typeof buildCheckpointReaderRuntime>>;
let next: typeof previous;
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-reader-test-")));
  previous = await buildCheckpointReaderRuntime(path.join(root, "previous"));
  next = await buildCheckpointReaderRuntime(path.join(root, "next"), true);
}, 60_000);
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
let sequence = 0;
async function fixture(runtime = previous) {
  const file = path.join(root, `staged-${sequence++}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec("BEGIN IMMEDIATE");
  db.exec(runtime.schema);
  db.exec(`PRAGMA user_version=${runtime.schemaVersion}`);
  db.prepare(
    "INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES('primary','global',?,1,1)",
  ).run(runtime.schemaVersion);
  db.exec("COMMIT");
  return { db, file };
}
const assertCurrent = (): undefined => undefined; // Fixture owns the staged database and runtimes.
describe("retained previous-runtime database reader", () => {
  it("executes genuinely different canonical runtime/schema fixtures without rewriting database families", async () => {
    const f = await fixture(next);
    try {
      const before = await inspectCheckpointFile(f.file);
      expect(await validate({ database: f.db, runtime: previous.runtime, assertCurrent })).toEqual({
        status: "unavailable",
        reason: "runtime-reader-refused",
      });
      expect(
        await validate({ database: f.db, runtime: next.runtime, assertCurrent }),
      ).toMatchObject({
        status: "verified",
        runtime: next.runtime,
        databasePath: f.file,
      });
      expect(await inspectCheckpointFile(f.file)).toEqual(before);
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        expect(await fs.stat(f.file + suffix).catch(() => null)).toBeNull();
      }
    } finally {
      f.db.close();
    }
  });
  it("checks real schema shape, not merely matching numeric user_version", async () => {
    const f = await fixture();
    try {
      f.db.exec("ALTER TABLE config_machine_state RENAME COLUMN value_json TO incompatible");
      expect(await validate({ database: f.db, runtime: previous.runtime, assertCurrent })).toEqual({
        status: "unavailable",
        reason: "runtime-reader-refused",
      });
    } finally {
      f.db.close();
    }
  });
  it("does not let a separate reader bless old committed bytes while incompatible writes are uncommitted", async () => {
    const f = await fixture();
    try {
      f.db.exec(
        "BEGIN IMMEDIATE; ALTER TABLE config_machine_state RENAME COLUMN value_json TO incompatible;",
      );
      expect(await validate({ database: f.db, runtime: previous.runtime, assertCurrent })).toEqual({
        status: "unavailable",
        reason: "uncommitted-database",
      });
      expect(f.db.isTransaction).toBe(true);
      f.db.exec("ROLLBACK");
      expect(
        await validate({ database: f.db, runtime: previous.runtime, assertCurrent }),
      ).toMatchObject({
        status: "verified",
      });
    } finally {
      f.db.close();
    }
  });
  it.each(["missing", "wrong-version", "wal", "lost-fence"] as const)(
    "refuses %s without accepting fallback validation",
    async (failure) => {
      const f = await fixture();
      try {
        if (failure === "wal") {
          await fs.writeFile(f.file + "-wal", "owned sidecar");
        }
        const before = await inspectCheckpointFile(f.file);
        const runtime = {
          ...previous.runtime,
          ...(failure === "missing" ? { root: path.join(root, "missing") } : {}),
          ...(failure === "wrong-version" ? { version: "wrong" } : {}),
        };
        const result = await validate({
          database: f.db,
          runtime,
          assertCurrent:
            failure === "lost-fence"
              ? () => {
                  throw new Error("lost");
                }
              : assertCurrent,
        });
        expect(result.status).toBe("unavailable");
        expect(await inspectCheckpointFile(f.file)).toEqual(before);
        if (failure === "wal") {
          expect(await fs.readFile(f.file + "-wal", "utf8")).toBe("owned sidecar");
          await fs.unlink(f.file + "-wal");
        }
      } finally {
        f.db.close();
      }
    },
  );
});
