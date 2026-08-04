import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function snapshotTree(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(`d ${relativePath}`);
        await walk(absolutePath, relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        snapshot.push(`l ${relativePath} ${await fs.readlink(absolutePath)}`);
        continue;
      }
      const contents = await fs.readFile(absolutePath);
      snapshot.push(`f ${relativePath} ${contents.toString("base64")}`);
    }
  };
  await walk(root, "");
  return snapshot;
}

async function sha256File(filePath: string): Promise<string> {
  const contents = await fs.readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

function snapshotDatabaseArtifacts(snapshot: string[]): string[] {
  return snapshot.filter((entry) => /^f .*\.sqlite(?:-(?:wal|shm))? /.test(entry));
}

function runUpdateDryRun(root: string, args: string[]) {
  const configPath = path.join(root, "config", "openclaw.json");
  const stateDir = path.join(root, "state");
  const entryPath = fileURLToPath(new URL("../entry.ts", import.meta.url));
  return spawnSync(process.execPath, ["--import", "tsx", entryPath, ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      ALL_PROXY: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      NO_COLOR: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DEBUG_PROXY_ENABLED: undefined,
      OPENCLAW_DEBUG_PROXY_REQUIRE: undefined,
      OPENCLAW_HIDE_BANNER: "1",
      OPENCLAW_HOME: root,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: stateDir,
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      all_proxy: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
}

describe("update dry-run process state", () => {
  it.each([
    ["root command", ["update", "--dry-run", "--no-restart", "--json"]],
    ["root shorthand", ["--update", "--dry-run", "--no-restart", "--json"]],
  ])("leaves isolated state unchanged for the %s", async (_name, args) => {
    const root = tempDirs.make("openclaw-update-dry-run-");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.mkdir(path.join(root, "state"), { recursive: true });
    await fs.writeFile(path.join(root, "config", "openclaw.json"), "{}\n");
    const before = await snapshotTree(root);

    const result = runUpdateDryRun(root, args);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("keeps malformed config immutable while producing a best-effort preview", async () => {
    const root = tempDirs.make("openclaw-update-dry-run-malformed-");
    const configPath = path.join(root, "config", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(root, "state"), { recursive: true });
    await fs.writeFile(configPath, "{ definitely-not-json\n");
    const configBefore = await fs.readFile(configPath);
    const treeBefore = await snapshotTree(root);

    const result = runUpdateDryRun(root, ["update", "--dry-run", "--no-restart", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      actions: expect.arrayContaining([expect.any(String)]),
    });
    expect(await fs.readFile(configPath)).toEqual(configBefore);
    expect(await snapshotTree(root)).toEqual(treeBefore);
  });

  it("keeps migration-pending config and SQLite markers immutable for the shorthand", async () => {
    const root = tempDirs.make("openclaw-update-dry-run-migration-");
    const configPath = path.join(root, "config", "openclaw.json");
    const tasksDir = path.join(root, "state", "tasks");
    const migrationMarkerPath = path.join(tasksDir, "runs.sqlite.migrated");
    const walPath = path.join(tasksDir, "runs.sqlite-wal");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      configPath,
      '{ "heartbeat": { "model": "anthropic/claude-3-5-haiku-20241022", "every": "30m" } }\n',
    );
    await fs.writeFile(migrationMarkerPath, "legacy migration marker\n");
    await fs.writeFile(walPath, "legacy WAL marker\n");
    const configBefore = await fs.readFile(configPath);
    const markerHashesBefore = {
      migration: await sha256File(migrationMarkerPath),
      wal: await sha256File(walPath),
    };
    const treeBefore = await snapshotTree(root);
    const databaseArtifactsBefore = snapshotDatabaseArtifacts(treeBefore);

    const result = runUpdateDryRun(root, ["--update", "--dry-run", "--no-restart", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true });
    expect(await fs.readFile(configPath)).toEqual(configBefore);
    expect(await snapshotTree(root)).toEqual(treeBefore);
    expect({
      migration: await sha256File(migrationMarkerPath),
      wal: await sha256File(walPath),
    }).toEqual(markerHashesBefore);
    expect(snapshotDatabaseArtifacts(await snapshotTree(root))).toEqual(databaseArtifactsBefore);
  });
});
