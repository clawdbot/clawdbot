import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readUpdateStateSchemaVersions,
  snapshotUpdateCandidateState,
  updateStateSchemaVersionsMatch,
} from "./update-candidate-state.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-state-")));
});
afterEach(async () => {
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

it.each(["DELETE", "WAL"])(
  "copies registered databases in %s mode without changing source artifacts",
  async (journalMode) => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const shared = path.join(source, "state", "openclaw.sqlite");
    const canonical = path.join(source, "agents", "main", "agent", "openclaw-agent.sqlite");
    const external = path.join(root, "external", "openclaw-agent.sqlite");
    await createDatabase(canonical);
    await createDatabase(external);
    await createDatabase(
      shared,
      "CREATE TABLE agent_databases(agent_id TEXT, path TEXT, PRIMARY KEY(agent_id,path));",
    );
    const registry = openNodeSqliteDatabase(shared);
    const insert = registry.prepare("INSERT INTO agent_databases VALUES (?, ?)");
    insert.run("external", external);
    insert.run("main", canonical);
    insert.run("main", path.relative(source, canonical));
    registry.close();
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
          entries: (await fs.readdir(path.dirname(file))).sort(),
        })),
      );
    const before = await artifacts();
    const inspected = await readUpdateStateSchemaVersions({ stateDir: source, config: {} });
    expect(inspected.filter((entry) => entry.userVersion === 3)).toHaveLength(3);
    expect(await artifacts()).toEqual(before);
    const versions = await snapshotUpdateCandidateState({
      stateDir: source,
      targetStateDir: target,
      config: {},
    });
    expect(versions.filter((entry) => entry.userVersion === 3)).toHaveLength(3);
    expect(await artifacts()).toEqual(before);
    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
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

    await snapshotUpdateCandidateState({ stateDir: source, targetStateDir: target, config: {} });

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
