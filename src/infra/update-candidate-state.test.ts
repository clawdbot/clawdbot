import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  readUpdateStateSchemaVersions,
  type snapshotUpdateCandidateState,
  updateStateSchemaVersionsMatch,
  UpdateStateSchemaVersionsSchema,
} from "./update-candidate-state.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-state-")));
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});

async function createDatabase(file: string, sql = ""): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = openNodeSqliteDatabase(file);
  try {
    db.exec(
      `PRAGMA user_version = 3; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('preserved'); ${sql}`,
    );
  } finally {
    db.close();
  }
}

async function runSnapshotWorker(input: Parameters<typeof snapshotUpdateCandidateState>[0]) {
  // Backup/VACUUM cannot be cancelled in-process; use the canary's worker before fixture cleanup.
  const result = await runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
      ),
    ],
    {
      input: JSON.stringify({ ...input, mode: "snapshot" }),
      timeoutMs: 30_000,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
    },
  );
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  return UpdateStateSchemaVersionsSchema.parse(JSON.parse(result.stdout.toString("utf8")));
}

it.each(["DELETE", "WAL"])(
  "copies registered databases in %s mode without source process leases or source artifact changes",
  async (journalMode) => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const shared = path.join(source, "state", "openclaw.sqlite");
    const canonical = path.join(source, "agents", "main", "agent", "openclaw-agent.sqlite");
    const external = path.join(root, "external", "openclaw-agent.sqlite");
    await createDatabase(canonical);
    await createDatabase(external);
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: source } }).db;
    const insert = registry.prepare(
      "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
    );
    insert.run("external", external);
    insert.run("main", canonical);
    insert.run("main", path.relative(source, canonical));
    const now = Date.now();
    registry
      .prepare("INSERT INTO agent_database_leases VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "live-main",
        "main",
        canonical,
        process.pid,
        getFileLockProcessStartTime(process.pid),
        now,
      );
    registry
      .prepare("INSERT INTO state_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "core:agent-database-maintenance",
        "global",
        "live-source-owner",
        now + 60_000,
        now,
        null,
        now,
        now,
      );
    closeOpenClawStateDatabaseByPath(shared);
    const sources = [shared, canonical, external];
    for (const file of sources) {
      const database = openNodeSqliteDatabase(file);
      database.exec(`PRAGMA journal_mode = ${journalMode};`);
      database.close();
    }
    const artifacts = async () =>
      Promise.all(
        sources.map(async (file) => ({
          bytes: await fs.readFile(file),
          entries: (await fs.readdir(path.dirname(file))).toSorted(),
        })),
      );
    const before = await artifacts();
    const inspected = await readUpdateStateSchemaVersions({ stateDir: source, config: {} });
    expect(inspected.filter((entry) => entry.userVersion === 3)).toHaveLength(2);
    expect(await artifacts()).toEqual(before);
    const versions = await runSnapshotWorker({
      stateDir: source,
      targetStateDir: target,
      config: {},
    });
    expect(versions).toEqual(inspected);
    await expect(
      withAgentDatabaseMaintenanceLease(
        {
          env: {
            OPENCLAW_STATE_DIR: target,
            OPENCLAW_CONFIG_PATH: path.join(target, "openclaw.json"),
          },
        },
        async (maintenance) => maintenance.assertOwned(),
      ),
    ).resolves.toBeUndefined();
    expect(await artifacts()).toEqual(before);
    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    expect(copiedRegistry.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
    expect(copiedRegistry.prepare("SELECT * FROM state_leases").all()).toEqual([]);
    expect(
      copiedRegistry
        .prepare("SELECT count(*) AS count FROM agent_databases WHERE agent_id = 'main'")
        .get(),
    ).toMatchObject({ count: 1 });
    const rebound = copiedRegistry
      .prepare("SELECT path FROM agent_databases WHERE agent_id = 'external'")
      .get() as {
      path: string;
    };
    copiedRegistry.close();
    expect(path.isAbsolute(rebound.path)).toBe(false);
    expect(rebound.path).toMatch(/^candidate-external/);
    for (const file of [
      path.join(target, rebound.path),
      path.join(target, "agents", "main", "agent", "openclaw-agent.sqlite"),
    ]) {
      const copied = openNodeSqliteDatabase(file);
      expect(copied.prepare("SELECT value FROM evidence").get()).toMatchObject({
        value: "preserved",
      });
      copied.close();
    }
  },
);

it("reads committed WAL schemas without ending the live writer's transaction", async () => {
  const stateDir = path.join(root, "live");
  const file = path.join(stateDir, "state", "openclaw.sqlite");
  await createDatabase(file, "PRAGMA journal_mode = WAL;");
  const writer = openNodeSqliteDatabase(file);
  try {
    writer.exec("PRAGMA user_version = 4; BEGIN IMMEDIATE; PRAGMA user_version = 5;");
    const versions = await readUpdateStateSchemaVersions({ stateDir, config: {} });
    expect(versions.find((entry) => entry.path === file)?.userVersion).toBe(4);
    expect(writer.isTransaction).toBe(true);
    expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

it("keeps absent stores explicit and observes newly created databases for rollback fencing", async () => {
  const stateDir = path.join(root, "state-owner");
  const before = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(before.every((entry) => entry.userVersion === null)).toBe(true);
  const main = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await createDatabase(main);
  const after = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(after.find((entry) => entry.path === main)?.userVersion).toBe(3);
  expect(updateStateSchemaVersionsMatch(before, after)).toBe(false);
  expect(updateStateSchemaVersionsMatch(after, after.toReversed())).toBe(true);
});

it("inspects with the installed candidate and selected Node after the old package is removed", async () => {
  const stateDir = path.join(root, "state-owner");
  await createDatabase(path.join(stateDir, "state", "openclaw.sqlite"));
  const previousRoot = path.join(root, "previous-package");
  const candidateRoot = path.join(root, "candidate-package");
  const worker = `
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const file = path.join(JSON.parse(input).stateDir, "state", "openclaw.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      console.log(JSON.stringify([{ path: file, userVersion: db.prepare("PRAGMA user_version").get().user_version }]));
    } finally {
      db.close();
    }
  `;
  for (const packageRoot of [previousRoot, candidateRoot]) {
    const file = path.join(packageRoot, "dist/infra/update-candidate-state.worker.js");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"type":"module"}');
    await fs.writeFile(file, worker);
  }
  const entrypoint = runtimeProcessEntrypoints.updateCandidateState;
  const originalModuleUrl = entrypoint.currentModuleUrl;
  Object.assign(entrypoint, {
    currentModuleUrl: pathToFileURL(path.join(previousRoot, "dist/old-updater.js")).href,
  });
  try {
    const before = await readUpdateStateSchemaVersions({ stateDir, config: {} });
    expect(before).toEqual([
      { path: path.join(stateDir, "state", "openclaw.sqlite"), userVersion: 3 },
    ]);
    await fs.rm(previousRoot, { recursive: true });
    const selectedNodeMarker = path.join(root, "selected-node-ran");
    let nodeRunner = process.execPath;
    if (process.platform !== "win32") {
      nodeRunner = path.join(root, "selected-node");
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await fs.writeFile(
        nodeRunner,
        `#!/bin/sh\nprintf selected > ${quote(selectedNodeMarker)}\nexec ${quote(process.execPath)} "$@"\n`,
        { mode: 0o755 },
      );
    }
    const after = await readUpdateStateSchemaVersions({
      stateDir,
      config: {},
      root: candidateRoot,
      nodeRunner,
    });
    expect(after).toEqual(before);
    if (process.platform !== "win32") {
      expect(await fs.readFile(selectedNodeMarker, "utf8")).toBe("selected");
    }
  } finally {
    Object.assign(entrypoint, { currentModuleUrl: originalModuleUrl });
  }
});

it.runIf(process.platform !== "win32")(
  "preserves distinct registered databases reached through symlink parent traversal",
  async () => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const shared = path.join(source, "state", "openclaw.sqlite");
    const symlinkTarget = path.join(source, "external", "subdir");
    await fs.mkdir(symlinkTarget, { recursive: true });
    await fs.symlink(symlinkTarget, path.join(source, "link"), "dir");
    const filesystemPath = path.join(source, "external", "x", "openclaw-agent.sqlite");
    const lexicalPath = path.join(source, "x", "openclaw-agent.sqlite");
    await createDatabase(filesystemPath, "UPDATE evidence SET value = 'filesystem';");
    await createDatabase(lexicalPath, "UPDATE evidence SET value = 'lexical';");
    await createDatabase(
      shared,
      "CREATE TABLE agent_databases(agent_id TEXT, path TEXT, PRIMARY KEY(agent_id,path));",
    );
    const registry = openNodeSqliteDatabase(shared);
    const insert = registry.prepare("INSERT INTO agent_databases VALUES (?, ?)");
    insert.run("filesystem", `link${path.sep}..${path.sep}x${path.sep}openclaw-agent.sqlite`);
    insert.run("lexical", lexicalPath);
    registry.close();

    await runSnapshotWorker({ stateDir: source, targetStateDir: target, config: {} });

    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    try {
      for (const owner of ["filesystem", "lexical"]) {
        const row = copiedRegistry
          .prepare("SELECT path FROM agent_databases WHERE agent_id = ?")
          .get(owner) as { path: string };
        const copied = openNodeSqliteDatabase(path.join(target, row.path));
        try {
          expect(copied.prepare("SELECT value FROM evidence").get()).toEqual({ value: owner });
        } finally {
          copied.close();
        }
      }
    } finally {
      copiedRegistry.close();
    }
  },
);
