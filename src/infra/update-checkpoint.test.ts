import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { sha256Hex } from "./crypto-digest.js";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import type { UpdateCheckpointPluginIndexMutation } from "./update-checkpoint-plugin-index.js";
import {
  inspectUpdateCheckpointRestoreResource,
  prepareUpdateCheckpointRestore,
  reopenUpdateCheckpointRestorePlan,
  restoreUpdateCheckpointResource,
  verifyUpdateCheckpointRestore,
} from "./update-checkpoint-restore.js";
import {
  captureUpdateCheckpoint,
  reopenUpdateCheckpoint,
  type UpdateCheckpointAccess,
  type UpdateCheckpointResource,
} from "./update-checkpoint.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "update-checkpoint-test-")),
  );
  roots.push(root);
  const stateDir = path.join(root, "live"),
    artifactRoot = path.join(root, "checkpoints"),
    configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
  await fs.writeFile(configPath, '{"before":true}');
  const access: UpdateCheckpointAccess = {
    artifactRoot,
    binding: {
      runId: "test-run",
      stateDir,
      configPath,
      fromRuntime: {
        root: path.join(root, "package"),
        version: "2026.8.1",
        nodePath: process.execPath,
      },
    },
    assertQuiescent() {},
  };
  const resources: UpdateCheckpointResource[] = [
    { sourcePath: configPath, kind: "config", restore: "replace" },
  ];
  // This disposable fixture owns every mutation and captures its output facts
  // before tests permit independent operator/agent work.
  const capture = async (pluginIndexMutations?: readonly UpdateCheckpointPluginIndexMutation[]) =>
    captureUpdateCheckpoint({
      ...access,
      resources,
      pluginIndexMutations,
      exclusions: ["workspace files are retained, never restored"],
      expectedSources: await Promise.all(
        resources
          .filter((resource) => resource.restore === "replace" && resource.kind !== "sqlite")
          .map(async ({ sourcePath }) => ({
            sourcePath,
            state: await inspectCheckpointFile(sourcePath),
          })),
      ),
    });
  return { access, resources, capture, stateDir, configPath };
}

describe("update checkpoint artifacts and publication", () => {
  it("restores exact config/service/plugin state without rewinding unrelated work, and reopens idempotently", async () => {
    const f = await fixture();
    const service = path.join(f.stateDir, "gateway.service"),
      plugin = path.join(f.stateDir, "plugin"),
      work = path.join(f.stateDir, "work.txt");
    await fs.writeFile(service, "Environment=OPERATOR=retained\n");
    await fs.mkdir(plugin);
    await fs.writeFile(path.join(plugin, "index.js"), "before");
    await fs.writeFile(work, "before");
    f.resources.push(
      { sourcePath: service, kind: "service", restore: "replace" },
      { sourcePath: plugin, kind: "plugin", restore: "replace" },
      { sourcePath: work, kind: "state", restore: "preserve" },
    );
    const checkpointRef = await f.capture();
    await fs.writeFile(f.configPath, '{"after":true}');
    await fs.writeFile(service, "candidate service");
    await fs.writeFile(path.join(plugin, "index.js"), "after");
    // This fixture is the mutation owner: retain outputs before ordinary work.
    const expectedSources = await Promise.all(
      f.resources
        .filter((resource) => resource.restore === "replace")
        .map(async ({ sourcePath }) => ({
          sourcePath,
          state: await inspectCheckpointFile(sourcePath),
        })),
    );
    const afterUpdateRef = await captureUpdateCheckpoint({
      ...f.access,
      resources: f.resources,
      exclusions: [],
      expectedSources,
    });
    await fs.writeFile(work, "new agent work");
    const prepared = await prepareUpdateCheckpointRestore({
      ...f.access,
      checkpointRef,
      afterUpdateRef,
      prepareSharedDatabase() {
        throw new Error("No database in this fixture");
      },
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      return;
    }
    for (let resourceCursor = 0; resourceCursor < 3; resourceCursor++) {
      expect(
        (
          await restoreUpdateCheckpointResource({
            ...f.access,
            planRef: prepared.planRef,
            resourceCursor,
          })
        ).status,
      ).toBe("applied");
      expect(
        (
          await restoreUpdateCheckpointResource({
            ...f.access,
            planRef: prepared.planRef,
            resourceCursor,
          })
        ).status,
      ).toBe("already-applied");
    }
    expect(await fs.readFile(f.configPath, "utf8")).toBe('{"before":true}');
    expect(await fs.readFile(service, "utf8")).toContain("OPERATOR=retained");
    expect(await fs.readFile(path.join(plugin, "index.js"), "utf8")).toBe("before");
    expect(await fs.readFile(work, "utf8")).toBe("new agent work");
  });

  it.each(["edited", "recreated", "newly created"])(
    "does not seal a checkpoint when an earlier service resource is %s during capture",
    async (change) => {
      const f = await fixture();
      const service = path.join(f.stateDir, "gateway.env");
      if (change !== "newly created") {
        await fs.writeFile(service, "OPERATOR=before\n");
      }
      // Service preimages precede the slower database/config capture. A later
      // real copy gives the lifecycle owner time to invalidate that preimage.
      f.resources.unshift({ sourcePath: service, kind: "service", restore: "replace" });
      const copy = fs.cp.bind(fs);
      vi.spyOn(fs, "cp").mockImplementation(async (source, target, options) => {
        await copy(source, target, options);
        if (source === f.configPath) {
          if (change === "recreated") {
            await fs.rename(service, `${service}.retained`);
            await fs.copyFile(`${service}.retained`, service);
          } else {
            await fs.writeFile(service, "OPERATOR=after\n");
          }
        }
      });
      await expect(f.capture()).rejects.toThrow(/changed before checkpoint seal/u);
      const directories = await fs.readdir(f.access.artifactRoot);
      for (const directory of directories) {
        await expect(
          fs.stat(path.join(f.access.artifactRoot, directory, "manifest.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await fs.readFile(service, "utf8")).toBe(
        change === "recreated" ? "OPERATOR=before\n" : "OPERATOR=after\n",
      );
    },
  );

  it("rejects edited checkpoint bytes and an unrelated current binding", async () => {
    const f = await fixture(),
      ref = await f.capture();
    await expect(
      reopenUpdateCheckpoint(ref, {
        ...f.access,
        binding: { ...f.access.binding, runId: "different" },
      }),
    ).rejects.toThrow(/binding mismatch/u);
    await fs.writeFile(path.join(path.dirname(ref.manifestPath), "resource-0"), "tampered");
    await expect(reopenUpdateCheckpoint(ref, f.access)).rejects.toThrow(/artifact changed/u);
  });

  it("does not overwrite an operator edit made after the update-owned after-image", async () => {
    const f = await fixture(),
      checkpointRef = await f.capture();
    await fs.writeFile(f.configPath, "update-owned");
    const afterUpdateRef = await f.capture();
    await fs.writeFile(f.configPath, "operator edit");
    expect(
      await prepareUpdateCheckpointRestore({
        ...f.access,
        checkpointRef,
        afterUpdateRef,
        prepareSharedDatabase() {},
      }),
    ).toEqual({ status: "unavailable", resource: f.configPath });
    expect(await fs.readFile(f.configPath, "utf8")).toBe("operator edit");
  });

  it("refuses a late after-image captured without the mutation owner's bindings", async () => {
    const f = await fixture();
    const checkpointRef = await f.capture();
    await fs.writeFile(f.configPath, "candidate output");
    await fs.writeFile(f.configPath, "newer operator work");
    const afterUpdateRef = await captureUpdateCheckpoint({
      ...f.access,
      resources: f.resources,
      exclusions: [],
    });
    expect(
      await prepareUpdateCheckpointRestore({
        ...f.access,
        checkpointRef,
        afterUpdateRef,
        prepareSharedDatabase() {},
      }),
    ).toEqual({ status: "unavailable", resource: f.configPath });
    expect(await fs.readFile(f.configPath, "utf8")).toBe("newer operator work");
  });

  it.each(["present", "absent", "plugin descendant"])(
    "does not replace an owner-bound %s after-image with a later observation",
    async (kind) => {
      const f = await fixture();
      const sourcePath = path.join(f.stateDir, "mutation-output");
      let target = sourcePath;
      if (kind === "plugin descendant") {
        await fs.mkdir(sourcePath);
        target = path.join(sourcePath, "index.js");
      }
      if (kind !== "absent") {
        await fs.writeFile(target, "owner output");
      }
      const expectedSources = [{ sourcePath, state: await inspectCheckpointFile(sourcePath) }];
      if (kind !== "absent") {
        await fs.rename(target, path.join(f.stateDir, "saved-owner-output"));
      }
      await fs.writeFile(target, "owner output");
      const current = await inspectCheckpointFile(sourcePath);
      const request = {
        ...f.access,
        resources: [{ sourcePath, kind: "service" as const, restore: "replace" as const }],
        exclusions: [],
        expectedSources,
      };
      await expect(captureUpdateCheckpoint(request)).rejects.toThrow(/source binding/u);
      expect(await inspectCheckpointFile(sourcePath)).toEqual(current);
    },
  );

  it.each(["candidate", "checkpoint", "plugin child"])(
    "rejects a recreated %s identity before restore preparation",
    async (phase) => {
      const f = await fixture();
      const plugin = path.join(f.stateDir, "plugin");
      await fs.mkdir(plugin);
      const child = path.join(plugin, "index.js");
      await fs.writeFile(child, "original");
      f.resources.push({ sourcePath: plugin, kind: "plugin", restore: "replace" });
      const checkpointRef = await f.capture();
      await fs.writeFile(f.configPath, "candidate");
      await fs.writeFile(child, "candidate plugin");
      const afterUpdateRef = await f.capture();
      const target = phase === "plugin child" ? child : f.configPath;
      const saved = path.join(f.stateDir, "operator-saved");
      await fs.rename(target, saved);
      await fs.copyFile(saved, target);
      if (phase === "checkpoint") {
        await fs.writeFile(target, '{"before":true}');
      }
      const expected = await inspectCheckpointFile(target);
      const result = await prepareUpdateCheckpointRestore({
        ...f.access,
        checkpointRef,
        afterUpdateRef,
        prepareSharedDatabase() {},
      });
      expect(result).toEqual({
        status: "unavailable",
        resource: phase === "plugin child" ? plugin : f.configPath,
      });
      expect(await inspectCheckpointFile(target)).toEqual(expected);
    },
  );

  it.each([
    ["file", "before", "replace"],
    ["file", "after", "replace"],
    ["plugin", "before", "replace"],
    ["plugin", "after", "replace"],
    ["file", "before", "rewrite"],
    ["file", "after", "rewrite"],
  ])("refuses a same-content %s %s identity change by %s", async (kind, phase, operation) => {
    const f = await fixture();
    const plugin = path.join(f.stateDir, "plugin");
    await fs.mkdir(plugin);
    const child = path.join(plugin, "index.js");
    await fs.writeFile(child, "plugin before");
    f.resources.push({ sourcePath: plugin, kind: "plugin", restore: "replace" });
    const checkpointRef = await f.capture();
    await fs.writeFile(f.configPath, "candidate config");
    await fs.writeFile(child, "plugin after");
    const afterUpdateRef = await f.capture();
    const prepared = await prepareUpdateCheckpointRestore({
      ...f.access,
      checkpointRef,
      afterUpdateRef,
      prepareSharedDatabase() {},
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      return;
    }
    const request = {
      ...f.access,
      planRef: prepared.planRef,
      resourceCursor: kind === "plugin" ? 1 : 0,
    };
    if (phase === "after") {
      await restoreUpdateCheckpointResource(request);
    }
    // Retain the original inode so the replacement cannot coincidentally reuse it.
    const target = kind === "plugin" ? child : f.configPath;
    const saved = path.join(f.stateDir, "operator-saved");
    if (operation === "replace") {
      await fs.rename(target, saved);
      await fs.copyFile(saved, target);
    } else {
      await fs.copyFile(target, saved);
      const stamp = await fs.stat(target);
      await fs.writeFile(target, await fs.readFile(target));
      // A deterministic newer write, without relying on timestamp resolution.
      await fs.utimes(target, stamp.atime, new Date(stamp.mtimeMs + 1000));
    }
    expect((await restoreUpdateCheckpointResource(request)).status).toBe("conflict");
    expect(await fs.readFile(target, "utf8")).toBe(await fs.readFile(saved, "utf8"));
  });

  it("refuses replay of a sealed legacy plan with an unbound after-image", async () => {
    const f = await fixture();
    const checkpointRef = await f.capture();
    await fs.writeFile(f.configPath, "newer operator work");
    const afterUpdateRef = await f.capture();
    const prepared = await prepareUpdateCheckpointRestore({
      ...f.access,
      checkpointRef,
      afterUpdateRef,
      prepareSharedDatabase() {},
    });
    if (prepared.status !== "ready") {
      throw new Error("fixture preparation unavailable");
    }
    const { plan } = await reopenUpdateCheckpointRestorePlan(prepared.planRef, f.access);
    const { manifest } = await reopenUpdateCheckpoint(afterUpdateRef, f.access);
    // Reproduce the older durable encoding, which had no checked owner binding.
    // Both digests are internally consistent; this is not a tamper-only test.
    for (const resource of manifest.resources) {
      delete resource.sourceBindingValidated;
    }
    const manifestBytes = JSON.stringify(manifest);
    await fs.writeFile(afterUpdateRef.manifestPath, manifestBytes);
    plan.afterUpdateRef = { ...afterUpdateRef, manifestSha256: sha256Hex(manifestBytes) };
    const planBytes = JSON.stringify(plan);
    await fs.writeFile(prepared.planRef.planPath, planBytes);
    const planRef = { ...prepared.planRef, planSha256: sha256Hex(planBytes) };
    await expect(
      restoreUpdateCheckpointResource({
        ...f.access,
        planRef,
        resourceCursor: 0,
      }),
    ).rejects.toThrow(/owner-bound after-image/u);
    expect(await fs.readFile(f.configPath, "utf8")).toBe("newer operator work");
  });

  it.each(["displaced", "published"])(
    "reconciles a crash after the resource was %s without a runtime write",
    async (phase) => {
      const f = await fixture();
      const checkpointRef = await f.capture();
      await fs.writeFile(f.configPath, "candidate");
      const afterUpdateRef = await f.capture();
      const prepared = await prepareUpdateCheckpointRestore({
        ...f.access,
        checkpointRef,
        afterUpdateRef,
        prepareSharedDatabase() {},
      });
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") {
        return;
      }
      const readAccess = { artifactRoot: f.access.artifactRoot, binding: f.access.binding };
      const reopened = await reopenUpdateCheckpointRestorePlan(prepared.planRef, readAccess);
      const resource = reopened.plan.resources[0]!;
      await fs.rename(f.configPath, path.join(resource.stageDirectory, "displaced"));
      if (phase === "published") {
        await fs.rename(path.join(resource.stageDirectory, "replacement"), f.configPath);
      }
      const request = {
        ...readAccess,
        planRef: structuredClone(prepared.planRef),
        resourceCursor: 0,
      };
      const before = await fs.readdir(resource.stageDirectory);
      expect((await inspectUpdateCheckpointRestoreResource(request)).observed).toBe(
        phase === "published" ? "after" : "before",
      );
      expect(await fs.readdir(resource.stageDirectory)).toEqual(before);
      expect(
        (
          await restoreUpdateCheckpointResource({
            ...request,
            assertQuiescent: f.access.assertQuiescent,
          })
        ).status,
      ).toBe(phase === "published" ? "already-applied" : "applied");
      const result = await verifyUpdateCheckpointRestore(request);
      expect(result.status).toBe("verified");
      expect(result.binding).toEqual(f.access.binding);
      expect(await fs.readFile(f.configPath, "utf8")).toBe('{"before":true}');
    },
  );

  it("binds absent databases so newer stores cannot be silently omitted from verification", async () => {
    const f = await fixture();
    const file = path.join(f.stateDir, "state", "openclaw.sqlite");
    f.resources.push({ sourcePath: file, kind: "sqlite", restore: "replace" });
    const checkpointRef = await f.capture();
    const afterUpdateRef = await f.capture();
    const prepared = await prepareUpdateCheckpointRestore({
      ...f.access,
      checkpointRef,
      afterUpdateRef,
      prepareSharedDatabase() {},
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      return;
    }
    const reopened = await reopenUpdateCheckpointRestorePlan(prepared.planRef, f.access);
    for (const resourceCursor of reopened.plan.resources.keys()) {
      await restoreUpdateCheckpointResource({
        ...f.access,
        planRef: prepared.planRef,
        resourceCursor,
      });
    }
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE work(text TEXT); INSERT INTO work VALUES('new work')");
    db.close();
    expect(
      (await verifyUpdateCheckpointRestore({ ...f.access, planRef: prepared.planRef })).status,
    ).toBe("conflict");
    const reader = new DatabaseSync(file, { readOnly: true });
    try {
      expect(reader.prepare("SELECT text FROM work").get()).toEqual({ text: "new work" });
    } finally {
      reader.close();
    }
  });

  it("publishes a canonical agent database retaining online transcript and external-content FTS identities", async () => {
    const f = await fixture(),
      file = path.join(f.stateDir, "state", "agent.sqlite");
    const mutate = (sql: string) => {
      const db = new DatabaseSync(file);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    };
    mutate(OPENCLAW_AGENT_SCHEMA_SQL + "PRAGMA user_version=1;");
    f.resources.push({ sourcePath: file, kind: "sqlite", restore: "replace" });
    const checkpointRef = await f.capture();
    mutate("PRAGMA user_version=2");
    const afterUpdateRef = await f.capture();
    mutate(
      "INSERT INTO session_transcript_fts(rowid, text, session_id, message_id, role, timestamp) VALUES(42, 'verification zebra', 'session', 'turn', 'assistant', 1); INSERT INTO standing_intents(intent_key, id, description, trigger_keywords, status, expires_at, max_fires, created_at) VALUES(99, 'online', 'new work', 'zebra', 'armed', 100, 1, 1)",
    );
    const prepared = await prepareUpdateCheckpointRestore({
      ...f.access,
      checkpointRef,
      afterUpdateRef,
      prepareSharedDatabase() {
        throw new Error("not shared");
      },
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      return;
    }
    expect(
      (
        await restoreUpdateCheckpointResource({
          ...f.access,
          planRef: prepared.planRef,
          resourceCursor: 1,
        })
      ).status,
    ).toBe("applied");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        db
          .prepare(
            "SELECT rowid, message_id FROM session_transcript_fts WHERE session_transcript_fts MATCH 'zebra'",
          )
          .all(),
      ).toEqual([{ rowid: 42, message_id: "turn" }]);
      expect(
        db
          .prepare(
            "SELECT rowid FROM standing_intents_fts WHERE standing_intents_fts MATCH 'zebra'",
          )
          .all(),
      ).toEqual([{ rowid: 99 }]);
      expect(db.prepare("SELECT id FROM standing_intents WHERE intent_key=99").get()).toEqual({
        id: "online",
      });
    } finally {
      db.close();
    }
  });

  it.each(["PRAGMA user_version=999", "CREATE TABLE unapproved_schema(id INTEGER)"])(
    "rejects a recovery callback changing the prior schema: %s",
    async (change) => {
      const f = await fixture(),
        file = path.join(f.stateDir, "state", "openclaw.sqlite");
      const db = new DatabaseSync(file);
      db.exec("PRAGMA user_version=1; CREATE TABLE work(text TEXT)");
      db.close();
      f.resources.push({ sourcePath: file, kind: "sqlite", restore: "replace" });
      const checkpointRef = await f.capture(),
        afterUpdateRef = await f.capture();
      await expect(
        prepareUpdateCheckpointRestore({
          ...f.access,
          checkpointRef,
          afterUpdateRef,
          prepareSharedDatabase({ stagedDb }) {
            stagedDb.exec(change);
          },
        }),
      ).rejects.toThrow(/schema/u);
      const live = new DatabaseSync(file, { readOnly: true });
      try {
        expect(live.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      } finally {
        live.close();
      }
    },
  );

  it.each([false, true])(
    "makes restore intent discoverable before sealing, including interrupted preparation (%s)",
    async (interrupt) => {
      const f = await fixture();
      const file = path.join(f.stateDir, "state", "openclaw.sqlite");
      const db = new DatabaseSync(file);
      db.exec(
        "CREATE TABLE config_machine_state(state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
      );
      db.close();
      f.resources.push({ sourcePath: file, kind: "sqlite", restore: "replace" });
      const checkpointRef = await f.capture();
      const afterUpdateRef = await f.capture();
      const preparation = prepareUpdateCheckpointRestore({
        ...f.access,
        checkpointRef,
        afterUpdateRef,
        prepareSharedDatabase({ sourceDb, stagedDb, restoreId, planIdentity }) {
          expect(planIdentity).toEqual({
            restoreId,
            checkpointId: checkpointRef.checkpointId,
            planPath: path.join(
              path.dirname(checkpointRef.manifestPath),
              `restore-${restoreId}.json`,
            ),
          });
          const intent = JSON.stringify(planIdentity);
          sourceDb
            .prepare("INSERT INTO config_machine_state VALUES('update.recovery.active',?,1)")
            .run(intent);
          if (interrupt) {
            throw new Error("interrupted after source intent");
          }
          stagedDb
            .prepare("INSERT INTO config_machine_state VALUES('update.recovery.active',?,1)")
            .run(intent);
        },
      });
      if (interrupt) {
        await expect(preparation).rejects.toThrow("interrupted after source intent");
      } else {
        const prepared = await preparation;
        expect(prepared.status).toBe("ready");
        if (prepared.status !== "ready") {
          return;
        }
        const reopened = await reopenUpdateCheckpointRestorePlan(prepared.planRef, f.access);
        const replacement = path.join(reopened.plan.resources[0]!.stageDirectory, "replacement");
        const stage = new DatabaseSync(replacement, { readOnly: true });
        try {
          expect(
            stage
              .prepare(
                "SELECT value_json FROM config_machine_state WHERE state_key='update.recovery.active'",
              )
              .get(),
          ).toEqual({
            value_json: JSON.stringify({
              restoreId: prepared.planRef.restoreId,
              checkpointId: prepared.planRef.checkpointId,
              planPath: prepared.planRef.planPath,
            }),
          });
        } finally {
          stage.close();
        }
      }
      const source = new DatabaseSync(file, { readOnly: true });
      try {
        const intent = source
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key='update.recovery.active'",
          )
          .get();
        expect(typeof intent?.value_json).toBe("string");
        const identity = JSON.parse(String(intent?.value_json));
        expect(identity.planSha256).toBeUndefined();
        if (interrupt) {
          await expect(fs.access(identity.planPath)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await expect(fs.access(identity.planPath)).resolves.toBeUndefined();
        }
      } finally {
        source.close();
      }
      expect(await fs.readFile(f.configPath, "utf8")).toBe('{"before":true}');
    },
  );

  it.each([false, true])(
    "preserves owned recovery rows and newer work, with plugin row conflict (%s)",
    async (pluginConflict) => {
      const f = await fixture(),
        file = path.join(f.stateDir, "state", "openclaw.sqlite");
      const mutate = (sql: string) => {
        const db = new DatabaseSync(file);
        try {
          db.exec(sql);
        } finally {
          db.close();
        }
      };
      mutate(
        "PRAGMA user_version=1; CREATE TABLE work(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO work VALUES(1, 'before'); CREATE TABLE update_runs(id TEXT PRIMARY KEY, outcome TEXT); INSERT INTO update_runs VALUES('previous','ok'); CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL); INSERT INTO config_machine_state VALUES('plugins.installedIndex', 'old-index', 1), ('operator', 'old-value', 1), ('update.recovery.active', '{\"revision\":1}', 1);",
      );
      f.resources.push({ sourcePath: file, kind: "sqlite", restore: "replace" });
      const checkpointRef = await f.capture();
      mutate(
        "PRAGMA user_version=2; INSERT INTO update_runs VALUES('current','applying'); UPDATE config_machine_state SET value_json='new-index', updated_at_ms=2 WHERE state_key='plugins.installedIndex'; UPDATE config_machine_state SET value_json='{\"revision\":2}', updated_at_ms=2 WHERE state_key='update.recovery.active'",
      );
      const afterUpdateRef = await f.capture([
        {
          databasePath: file,
          before: {
            state_key: "plugins.installedIndex",
            value_json: "old-index",
            updated_at_ms: 1,
          },
          after: { state_key: "plugins.installedIndex", value_json: "new-index", updated_at_ms: 2 },
        },
      ]);
      if (pluginConflict) {
        mutate(
          "UPDATE config_machine_state SET value_json='operator-plugin-edit',updated_at_ms=3 WHERE state_key='plugins.installedIndex'",
        );
      }
      mutate(
        "INSERT INTO work VALUES(2,'online verification turn'); UPDATE config_machine_state SET value_json='new-operator-value', updated_at_ms=3 WHERE state_key='operator'; UPDATE config_machine_state SET value_json='{\"revision\":3}', updated_at_ms=3 WHERE state_key='update.recovery.active'",
      );
      const prepared = await prepareUpdateCheckpointRestore({
        ...f.access,
        checkpointRef,
        afterUpdateRef,
        prepareSharedDatabase({ sourceDb, stagedDb }) {
          sourceDb.exec(
            "UPDATE config_machine_state SET value_json='{\"revision\":4}', updated_at_ms=4 WHERE state_key='update.recovery.active'",
          );
          const recovery = sourceDb
            .prepare("SELECT * FROM config_machine_state WHERE state_key='update.recovery.active'")
            .get()!;
          stagedDb
            .prepare("INSERT OR REPLACE INTO config_machine_state VALUES(?,?,?)")
            .run(recovery.state_key!, recovery.value_json!, recovery.updated_at_ms!);
          stagedDb.exec("DELETE FROM update_runs");
          for (const row of sourceDb.prepare("SELECT id, outcome FROM update_runs").all()) {
            stagedDb.prepare("INSERT INTO update_runs VALUES (?,?)").run(row.id!, row.outcome!);
          }
        },
      });
      if (pluginConflict) {
        expect(prepared).toEqual({ status: "unavailable", resource: "config_machine_state" });
        const live = new DatabaseSync(file, { readOnly: true });
        try {
          expect(
            live
              .prepare("SELECT value_json FROM config_machine_state WHERE state_key='operator'")
              .get(),
          ).toEqual({ value_json: "new-operator-value" });
          expect(live.prepare("SELECT text FROM work WHERE id=2").get()).toEqual({
            text: "online verification turn",
          });
          expect(live.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
        } finally {
          live.close();
        }
        return;
      }
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") {
        return;
      }
      // Simulate a fresh recovery invocation using only the immutable plan ref.
      await restoreUpdateCheckpointResource({
        ...f.access,
        planRef: structuredClone(prepared.planRef),
        resourceCursor: 0,
      });
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        expect(
          db
            .prepare("SELECT state_key, value_json FROM config_machine_state ORDER BY state_key")
            .all(),
        ).toEqual([
          { state_key: "operator", value_json: "new-operator-value" },
          { state_key: "plugins.installedIndex", value_json: "old-index" },
          { state_key: "update.recovery.active", value_json: '{"revision":4}' },
        ]);
        expect(db.prepare("SELECT text FROM work ORDER BY id").all()).toEqual([
          { text: "before" },
          { text: "online verification turn" },
        ]);
        expect(db.prepare("SELECT outcome FROM update_runs WHERE id='current'").get()).toEqual({
          outcome: "applying",
        });
      } finally {
        db.close();
      }
    },
  );
});
