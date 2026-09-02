import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../infra/update-control-plane-sentinel.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";

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
      snapshot.push(`f ${relativePath} ${await sha256File(absolutePath)}`);
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

function runUpdateProcess(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const configPath = path.join(root, "config", "openclaw.json");
  const stateDir = path.join(root, "state");
  const entryPath = path.resolve("openclaw.mjs");
  return spawnSync(process.execPath, [entryPath, ...args], {
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
      OPENCLAW_SUPERVISOR_MODE: undefined,
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      all_proxy: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      ...env,
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
}

describe("update process state", () => {
  it.each([true, false])(
    "keeps cleanup preview/refusal byte-identical (dryRun=%s)",
    async (dryRun) => {
      const root = tempDirs.make("openclaw-cleanup-process-");
      const config = path.join(root, "config", "openclaw.json");
      const runs = path.join(root, "state", "session-sqlite-migration-runs");
      const cache = path.join(root, "cache");
      const temporary = path.join(root, "tmp");
      await fs.mkdir(path.dirname(config), { recursive: true });
      await fs.mkdir(runs, { recursive: true });
      await fs.mkdir(cache);
      await fs.mkdir(temporary);
      await fs.writeFile(config, "{ invalid-config");
      await fs.writeFile(path.join(runs, "unknown.json"), "{ invalid-manifest");
      const before = await snapshotTree(root);
      const result = runUpdateProcess(
        root,
        dryRun ? ["update", "--json", "--dry-run", "cleanup"] : ["update", "cleanup", "--json"],
        { XDG_CACHE_HOME: cache, TMPDIR: temporary },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(dryRun ? 0 : 1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: dryRun ? "preview" : "refused" });
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it("keeps malformed config immutable while producing a best-effort preview", async () => {
    const root = tempDirs.make("openclaw-update-dry-run-malformed-");
    const configPath = path.join(root, "config", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(root, "state"), { recursive: true });
    await fs.writeFile(configPath, "{ definitely-not-json\n");
    const configBefore = await fs.readFile(configPath);
    const treeBefore = await snapshotTree(root);

    const result = runUpdateProcess(root, ["update", "--dry-run", "--no-restart", "--json"]);

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

    const result = runUpdateProcess(root, ["--update", "--dry-run", "--no-restart", "--json"]);

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

  it.each(["update", "repair"])(
    "keeps rejected %s arguments from touching legacy state",
    async (command) => {
      const root = tempDirs.make("openclaw-update-legacy-state-");
      const configPath = path.join(root, "config", "openclaw.json");
      const sessionsDir = path.join(root, "state", "sessions");
      const sessionId = "legacy-会議-session";
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(configPath, '{ "gateway": { "mode": "local" } }\n');
      await fs.writeFile(
        path.join(sessionsDir, "sessions.json"),
        `${JSON.stringify({
          "agent:main:discord:direct:user": {
            sessionId,
            sessionFile: path.join(sessionsDir, `${sessionId}.jsonl`),
            updatedAt: 1,
          },
        })}\n`,
      );
      await fs.writeFile(
        path.join(sessionsDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: "session", id: sessionId })}\n`,
      );
      const before = await snapshotTree(root);

      const result = runUpdateProcess(root, [
        "update",
        ...(command === "repair" ? ["repair"] : []),
        "--timeout",
        "invalid",
        ...(command === "update" ? ["--no-restart"] : []),
        "--json",
      ]);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /--timeout must be a positive integer/iu,
      );
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it("keeps an orphaned SQLite journal immutable when a managed handoff is refused", async () => {
    const root = tempDirs.make("openclaw-update-refused-handoff-");
    const configPath = path.join(root, "config", "openclaw.json");
    const stateDir = path.join(root, "state");
    const metaPath = path.join(root, "handoff.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
    await fs.writeFile(configPath, '{ "gateway": { "mode": "local" } }\n');
    await fs.writeFile(path.join(stateDir, "state", "openclaw.sqlite-journal"), "orphan journal\n");
    await fs.writeFile(
      metaPath,
      `${JSON.stringify({ version: 1, meta: { root: path.join(root, "wrong-install") } })}\n`,
    );
    const before = await snapshotTree(root);

    const result = runUpdateProcess(root, ["update", "--no-restart", "--json"], {
      [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Managed update handoff root mismatch/iu);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it.each(["update", "repair", "cleanup"])(
    "fences the mutable %s path before observation or action",
    async (command) => {
      const root = tempDirs.make("openclaw-update-owned-state-");
      const configPath = path.join(root, "config", "openclaw.json");
      const stateDir = path.join(root, "state");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, '{ "gateway": { "mode": "local" } }\n');
      const externalEnv = {
        ...process.env,
        HOME: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SUPERVISOR_MODE: "external",
      };
      claimOpenClawStateOwnership("gateway-supervisor", { env: externalEnv });
      const databasePath = openOpenClawStateDatabase({ env: externalEnv }).path;
      closeOpenClawStateDatabaseForTest();
      const before = await snapshotTree(root);
      const beforeDatabaseHash = await sha256File(databasePath);

      const refused = runUpdateProcess(
        root,
        command === "cleanup"
          ? ["update", "cleanup", "--yes", "--json"]
          : [
              "update",
              ...(command === "repair" ? ["repair"] : ["--no-restart"]),
              "--timeout",
              "1",
              "--json",
            ],
      );

      expect(refused.error).toBeUndefined();
      expect(refused.status).not.toBe(0);
      expect(`${refused.stdout}\n${refused.stderr}`).toMatch(/gateway-supervisor/u);
      expect(`${refused.stdout}\n${refused.stderr}`).toMatch(/OPENCLAW_SUPERVISOR_MODE=external/u);
      expect(await snapshotTree(root)).toEqual(before);
      expect(await sha256File(databasePath)).toBe(beforeDatabaseHash);
    },
  );
});
