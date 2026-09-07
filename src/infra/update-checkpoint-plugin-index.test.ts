import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto-digest.js";
import {
  prepareUpdateCheckpointRestore,
  reopenUpdateCheckpointRestorePlan,
  restoreUpdateCheckpointResource,
} from "./update-checkpoint-restore.js";
import { buildCheckpointReaderRuntime } from "./update-checkpoint-runtime.test-support.js";
import {
  captureUpdateCheckpoint,
  reopenUpdateCheckpoint,
  type UpdateCheckpointAccess,
} from "./update-checkpoint.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
const row = (value: string, time: number) => ({
  state_key: "plugins.installedIndex",
  value_json: value,
  updated_at_ms: time,
});
type Mutation = {
  databasePath: string;
  before: ReturnType<typeof row> | null;
  after: ReturnType<typeof row>;
};
async function fixture(absent = false) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-plugin-row-")),
  );
  roots.push(root);
  const runtime = await buildCheckpointReaderRuntime(path.join(root, "package"));
  const stateDir = path.join(root, "live");
  await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
  const file = path.join(stateDir, "state", "openclaw.sqlite");
  const sql = (query: string) => {
    const db = new DatabaseSync(file);
    try {
      db.exec(query);
    } finally {
      db.close();
    }
  };
  sql(
    `BEGIN IMMEDIATE; ${runtime.schema}
     PRAGMA user_version=${runtime.schemaVersion};
     INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at)
     VALUES('primary','global',${runtime.schemaVersion},1,1);
     INSERT INTO config_machine_state VALUES('operator','before',1);
     CREATE TABLE work(id INTEGER PRIMARY KEY, text TEXT); COMMIT;`,
  );
  if (!absent) {
    sql("INSERT INTO config_machine_state VALUES('plugins.installedIndex','old',1)");
  }
  const access: UpdateCheckpointAccess = {
    artifactRoot: path.join(root, "checkpoints"),
    binding: {
      runId: "row-test",
      stateDir,
      configPath: path.join(stateDir, "config.json"),
      fromRuntime: runtime.runtime,
    },
    assertQuiescent() {},
  };
  const capture = (pluginIndexMutations?: readonly Mutation[]) =>
    captureUpdateCheckpoint({
      ...access,
      resources: [{ sourcePath: file, kind: "sqlite", restore: "replace" }],
      exclusions: [],
      pluginIndexMutations,
    });
  const checkpointRef = await capture();
  // Synthetic mutation owner retains raw committed row facts, not a rollback-time read.
  const mutation: Mutation = {
    databasePath: file,
    before: absent ? null : row("old", 1),
    after: row("candidate", 2),
  };
  sql("INSERT OR REPLACE INTO config_machine_state VALUES('plugins.installedIndex','candidate',2)");
  const prepare = (afterUpdateRef: Awaited<ReturnType<typeof capture>>) =>
    prepareUpdateCheckpointRestore({
      ...access,
      checkpointRef,
      afterUpdateRef,
      prepareSharedDatabase() {},
    });
  return { file, access, sql, capture, checkpointRef, mutation, prepare };
}

describe("checkpoint plugin-index mutation binding", () => {
  it.each(["timestamp", "wrong database", "discontinuous"])(
    "rejects %s receipt facts during capture",
    async (kind) => {
      const f = await fixture();
      const mutations = [structuredClone(f.mutation)];
      if (kind === "timestamp") {
        mutations[0]!.after.updated_at_ms = 3;
      }
      if (kind === "wrong database") {
        mutations[0]!.databasePath += ".other";
      }
      if (kind === "discontinuous") {
        mutations.unshift({ ...f.mutation, after: row("not-the-next-before", 0) });
      }
      await expect(f.capture(mutations)).rejects.toThrow(/plugin-index mutation/iu);
    },
  );
  it.each(["missing", "wrong before"])(
    "refuses restoration with %s owner receipt without replacing live state",
    async (kind) => {
      const f = await fixture();
      const mutation = { ...f.mutation, before: row("not-checkpoint", 1) };
      const after = await f.capture(kind === "missing" ? undefined : [mutation]);
      const bytes = await fs.readFile(f.file);
      expect(await f.prepare(after)).toEqual({ status: "unavailable", resource: f.file });
      expect(await fs.readFile(f.file)).toEqual(bytes);
    },
  );
  it.each([false, true])(
    "restores an exact receipt chain (absent before=%s) while retaining interval and online work",
    async (absent) => {
      const f = await fixture(absent);
      f.sql(
        "UPDATE config_machine_state SET value_json='operator during convergence',updated_at_ms=9 WHERE state_key='operator'; INSERT INTO work VALUES(1,'online before after-image')",
      );
      const next = { ...f.mutation, before: f.mutation.after, after: row("final-candidate", 3) };
      f.sql(
        "UPDATE config_machine_state SET value_json='final-candidate',updated_at_ms=3 WHERE state_key='plugins.installedIndex'",
      );
      const after = await f.capture([f.mutation, next]);
      f.sql("INSERT INTO work VALUES(2,'verification turn')");
      const prepared = await f.prepare(after);
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") {
        return;
      }
      expect(
        (
          await restoreUpdateCheckpointResource({
            ...f.access,
            planRef: prepared.planRef,
            resourceCursor: 0,
          })
        ).status,
      ).toBe("applied");
      const db = new DatabaseSync(f.file, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT * FROM config_machine_state WHERE state_key='plugins.installedIndex'")
            .get() ?? null,
        ).toEqual(f.mutation.before);
        expect(
          db
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key='operator'")
            .get(),
        ).toEqual({ value_json: "operator during convergence" });
        expect(db.prepare("SELECT text FROM work ORDER BY id").all()).toEqual([
          { text: "online before after-image" },
          { text: "verification turn" },
        ]);
      } finally {
        db.close();
      }
    },
  );
  it("rejects digest-valid replay whose after-image lost the receipt", async () => {
    const f = await fixture();
    const after = await f.capture([f.mutation]);
    const prepared = await f.prepare(after);
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      return;
    }
    const { manifest } = await reopenUpdateCheckpoint(after, f.access);
    delete manifest.pluginIndexMutations;
    const bytes = JSON.stringify(manifest);
    await fs.writeFile(after.manifestPath, bytes);
    const plan = JSON.parse(await fs.readFile(prepared.planRef.planPath, "utf8"));
    plan.afterUpdateRef = { ...after, manifestSha256: sha256Hex(bytes) };
    const planBytes = JSON.stringify(plan);
    await fs.writeFile(prepared.planRef.planPath, planBytes);
    await expect(
      reopenUpdateCheckpointRestorePlan(
        { ...prepared.planRef, planSha256: sha256Hex(planBytes) },
        f.access,
      ),
    ).rejects.toThrow(/plugin-index mutation/iu);
  });
});
