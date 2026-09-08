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
let legacy: typeof previous;
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-reader-test-")));
  previous = await buildCheckpointReaderRuntime(path.join(root, "previous"), false, false, {
    agentReader: true,
  });
  next = await buildCheckpointReaderRuntime(path.join(root, "next"), true, false, {
    agentReader: true,
  });
  legacy = await buildCheckpointReaderRuntime(path.join(root, "unsupported"));
}, 60_000);
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
let sequence = 0;
async function fixture(runtime = previous) {
  const file = path.join(root, `agent-${sequence++}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec(`BEGIN; ${runtime.agentSchema}; PRAGMA user_version=${runtime.agentSchemaVersion};`);
  db.prepare(
    "INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES('primary','agent',?,'main',1,1)",
  ).run(runtime.agentSchemaVersion);
  db.exec("COMMIT");
  return { db, file };
}
const assertCurrent = (): undefined => undefined; // This fixture owns all files/handles.
describe("retained agent runtime reader", () => {
  it("executes different real CLI readers and schemas, never substituting shared schema validation", async () => {
    const f = await fixture(next);
    try {
      const before = await inspectCheckpointFile(f.file);
      expect(
        (
          await validate({
            database: f.db,
            runtime: previous.runtime,
            agentId: "main",
            assertCurrent,
          })
        ).status,
      ).toBe("unavailable");
      expect(
        await validate({ database: f.db, runtime: next.runtime, agentId: "main", assertCurrent }),
      ).toMatchObject({ status: "verified", databasePath: f.file });
      expect(await inspectCheckpointFile(f.file)).toEqual(before);
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        expect(await fs.stat(f.file + suffix).catch(() => null)).toBeNull();
      }
    } finally {
      f.db.close();
    }
  });
  it.each([
    "wrong-agent",
    "invalid-agent",
    "same-version-shape",
    "retired-state-leases",
    "wrong-marker",
    "uncommitted",
    "unsupported-reader",
    "sidecar",
  ] as const)("refuses %s without mutating or repairing", async (failure) => {
    const f = await fixture();
    try {
      if (failure === "same-version-shape") {
        f.db.exec("ALTER TABLE standing_intents RENAME COLUMN description TO incompatible");
      }
      if (failure === "retired-state-leases") {
        f.db.exec("CREATE TABLE state_leases(id TEXT PRIMARY KEY)");
      }
      if (failure === "wrong-marker") {
        f.db.exec("UPDATE schema_meta SET schema_version=1");
      }
      if (failure === "uncommitted") {
        f.db.exec("BEGIN; UPDATE schema_meta SET agent_id='other'");
      }
      if (failure === "sidecar") {
        await fs.writeFile(f.file + "-wal", "owned sidecar");
      }
      const before = await inspectCheckpointFile(f.file);
      expect(
        (
          await validate({
            database: f.db,
            runtime: failure === "unsupported-reader" ? legacy.runtime : previous.runtime,
            agentId:
              failure === "wrong-agent" ? "other" : failure === "invalid-agent" ? "!!!" : "main",
            assertCurrent,
          })
        ).status,
      ).toBe("unavailable");
      expect(await inspectCheckpointFile(f.file)).toEqual(before);
      if (failure === "uncommitted") {
        expect(f.db.isTransaction).toBe(true);
        f.db.exec("ROLLBACK");
      }
      if (failure === "sidecar") {
        expect(await fs.readFile(f.file + "-wal", "utf8")).toBe("owned sidecar");
        await fs.unlink(f.file + "-wal");
      }
    } finally {
      f.db.close();
    }
  });
});
