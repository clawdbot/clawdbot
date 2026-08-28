import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { backupGitCreateCommand } from "../commands/backup-git.js";
import { readBackupFreshness } from "../commands/backup-health.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { executeGitCommand, requireGitCommand as requireGit } from "../infra/git-exec.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createPathResolutionEnv, withEnvAsync } from "../test-utils/env.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";
import { createGitBackup, initializeGitBackupRepository } from "./git-backup.js";

const mocks = vi.hoisted(() => ({ pushDiagnostic: undefined as string | undefined }));

vi.mock("../infra/git-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/git-exec.js")>();
  return {
    ...actual,
    executeGitCommand: async (
      ...args: Parameters<typeof actual.executeGitCommand>
    ): ReturnType<typeof actual.executeGitCommand> => {
      if (args[1][0] === "push" && mocks.pushDiagnostic) {
        return {
          code: 1,
          stdout: "",
          stderr: mocks.pushDiagnostic,
          signal: null,
          killed: false,
          termination: "exit",
          timeoutMs: args[2]?.timeoutMs ?? actual.GIT_TIMEOUT_MS,
        };
      }
      return await actual.executeGitCommand(...args);
    },
  };
});

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-backup-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  mocks.pushDiagnostic = undefined;
  closeOpenClawStateDatabaseForTest();
  await Promise.all(
    roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

async function createFormatFixture(databasePath: string): Promise<void> {
  const database = new DatabaseSync(databasePath, { allowExtension: true });
  try {
    await loadSqliteVecExtension({ db: database });
    database.exec(`
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE device_auth_tokens (
        device_id TEXT NOT NULL,
        role TEXT NOT NULL,
        token TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (device_id, role)
      ) STRICT;
      CREATE TABLE channel_pairing_requests (
        channel_key TEXT NOT NULL,
        account_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        meta_json TEXT,
        PRIMARY KEY (channel_key, account_id, request_id)
      ) STRICT;
      CREATE TABLE device_pairing_join_codes (
        shortcode TEXT,
        payload_json TEXT,
        created_at_ms INTEGER,
        expires_at_ms INTEGER
      ) STRICT;
      CREATE TABLE content (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        huge INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        optional TEXT
      );
      CREATE VIRTUAL TABLE content_fts USING fts5(body, content='content', content_rowid='id');
      CREATE TRIGGER content_ai AFTER INSERT ON content BEGIN
        INSERT INTO content_fts(rowid, body) VALUES (new.id, new.body);
      END;
      CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[2]);
      CREATE TABLE empty_table (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE session_transcript_index_state (id TEXT PRIMARY KEY, cursor INTEGER);
    `);
    database
      .prepare(
        `INSERT INTO schema_meta
           (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)`,
      )
      .run(OPENCLAW_STATE_SCHEMA_VERSION);
    database
      .prepare("INSERT INTO content (id, body, huge, bytes, optional) VALUES (?, ?, ?, ?, ?)")
      .run(1, "hello lobster", 9_007_199_254_740_993n, Buffer.from([0, 1, 254, 255]), "");
    database
      .prepare("INSERT INTO content (id, body, huge, bytes, optional) VALUES (?, ?, ?, ?, ?)")
      .run(2, "second row", -9_007_199_254_740_994n, Buffer.from([42]), null);
    database.prepare("INSERT INTO session_transcript_index_state VALUES (?, ?)").run("main", 99);
    database
      .prepare(
        `INSERT INTO device_auth_tokens
           (device_id, role, token, scopes_json, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("device", "operator", "secret-token", "[]", 1);
    database
      .prepare(
        `INSERT INTO channel_pairing_requests
           (channel_key, account_id, request_id, code, created_at, last_seen_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("telegram", "default", "request", "pairing-code", "now", "now", null);
    database
      .prepare(
        `INSERT INTO device_pairing_join_codes
           (shortcode, payload_json, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "join-code",
        JSON.stringify({ url: "wss://gateway.example", bootstrapToken: "bootstrap-secret" }),
        1,
        2,
      );
  } finally {
    database.close();
  }
}

function createAgentFixture(databasePath: string, agentId: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    database
      .prepare(
        `INSERT INTO schema_meta
           (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', 'agent', ?, ?, NULL, 1, 1)`,
      )
      .run(OPENCLAW_AGENT_SCHEMA_VERSION, agentId);
  } finally {
    database.close();
  }
}

async function writeBackupManifest(scopePath: string, agentId: string): Promise<void> {
  await fs.mkdir(scopePath, { recursive: true });
  await fs.writeFile(
    path.join(scopePath, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      identity: { role: "agent", agentId },
      userVersion: 1,
      excludedTables: [],
      tables: {},
    })}\n`,
  );
}

async function listTree(root: string): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else {
        result.push([relative, (await fs.readFile(entryPath)).toString("hex")]);
      }
    }
  }
  await visit(root);
  return result;
}

function createStateDatabaseFixture(root: string): {
  stateDir: string;
  database: { path: string; identity: { role: "global" } };
} {
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  closeOpenClawStateDatabaseForTest();
  return {
    stateDir,
    database: {
      path: resolveOpenClawStateSqlitePath(env),
      identity: { role: "global" },
    },
  };
}

describe("Git-backed SQLite snapshots", () => {
  it("rejects state and repository overlap in either canonical direction", async () => {
    const root = await fs.realpath(await tempRoot());
    const stateDir = path.join(root, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const stateAlias = path.join(root, "state-alias");
    await fs.symlink(stateDir, stateAlias, process.platform === "win32" ? "junction" : "dir");

    for (const repositoryPath of [
      path.join(stateDir, "backup"),
      root,
      path.join(stateAlias, "backup"),
    ]) {
      await expect(initializeGitBackupRepository({ repositoryPath, stateDir })).rejects.toThrow(
        `Git backup repository must be outside the OpenClaw state directory: ${stateDir}`,
      );
    }
  });

  it("dumps byte-identical trees and skips a second unchanged create commit", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source.sqlite");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await createFormatFixture(source);

    await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: first,
      identity: { role: "global" },
    });
    await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: second,
      identity: { role: "global" },
    });
    expect(await listTree(second)).toEqual(await listTree(first));

    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    await initializeGitBackupRepository({ repositoryPath, stateDir });
    await requireGit(repositoryPath, ["config", "user.name", "OpenClaw Backup Test"]);
    await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);
    const created = await createGitBackup({ repositoryPath, stateDir, databases: [database] });
    const unchanged = await createGitBackup({ repositoryPath, stateDir, databases: [database] });
    expect(created.noChanges).toBe(false);
    expect(unchanged.noChanges).toBe(true);
    expect(unchanged).not.toHaveProperty("commit");
    expect(await requireGit(repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("backs up a configured external agent database for explicit and all scopes", async () => {
    const root = await fs.realpath(await tempRoot());
    const { stateDir } = createStateDatabaseFixture(root);
    const agentDir = path.join(root, "external-agent");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(agentDir, { recursive: true });
    const { closeOpenClawAgentDatabaseByPath, openOpenClawAgentDatabase } =
      await import("../state/openclaw-agent-db.js");
    const agentDatabase = openOpenClawAgentDatabase({
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      path: path.join(agentDir, "openclaw-agent.sqlite"),
    });
    closeOpenClawAgentDatabaseByPath(agentDatabase.path);
    await fs.writeFile(configPath, JSON.stringify({ agents: { entries: { main: { agentDir } } } }));

    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        for (const { scope, selection } of [
          { scope: "explicit", selection: { agents: ["main"] } },
          { scope: "all", selection: { all: true } },
        ]) {
          const repositoryPath = path.join(root, `${scope}-repository`);
          const result = await backupGitCreateCommand(createTestRuntime(), {
            repository: repositoryPath,
            ...selection,
          });
          const manifest = JSON.parse(
            await fs.readFile(path.join(repositoryPath, "agents", "main", "manifest.json"), "utf8"),
          ) as { identity: { role: string; agentId: string } };

          expect(result.commit).toMatch(/^[a-f0-9]{40}$/u);
          expect(manifest.identity).toEqual({ role: "agent", agentId: "main" });
          if (scope === "all") {
            await expect(
              fs.stat(path.join(repositoryPath, "global", "manifest.json")),
            ).resolves.toBeDefined();
          }
        }
      },
    );
  });

  it("stages only backup-owned paths in an adopted repository", async () => {
    const root = await tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    await initializeGitBackupRepository({ repositoryPath, stateDir });
    await requireGit(repositoryPath, ["config", "user.name", "OpenClaw Backup Test"]);
    await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);
    await fs.writeFile(path.join(repositoryPath, "unrelated.txt"), "operator-owned\n");
    await requireGit(repositoryPath, ["add", "unrelated.txt"]);

    const created = await createGitBackup({ repositoryPath, stateDir, databases: [database] });
    const unchanged = await createGitBackup({ repositoryPath, stateDir, databases: [database] });

    expect(created.noChanges).toBe(false);
    expect(unchanged.noChanges).toBe(true);
    expect(await requireGit(repositoryPath, ["status", "--porcelain", "--", "unrelated.txt"])).toBe(
      "A  unrelated.txt",
    );
    const committedPaths = (
      await requireGit(repositoryPath, ["show", "--pretty=format:", "--name-only", "HEAD"])
    )
      .split("\n")
      .filter(Boolean);
    expect(committedPaths.length).toBeGreaterThan(0);
    expect(
      committedPaths.every(
        (entry) =>
          entry === "global" ||
          entry.startsWith("global/") ||
          entry === "agents" ||
          entry.startsWith("agents/"),
      ),
    ).toBe(true);
    expect(committedPaths).not.toContain("unrelated.txt");
    expect(
      await requireGit(repositoryPath, ["ls-tree", "-r", "--name-only", "HEAD"]),
    ).not.toContain("unrelated.txt");
    expect(await requireGit(repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("preserves an unowned global namespace in an adopted repository", async () => {
    const root = await tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    const operatorFile = path.join(repositoryPath, "global", "operator.txt");
    await initializeGitBackupRepository({ repositoryPath, stateDir });
    await fs.mkdir(path.dirname(operatorFile), { recursive: true });
    await fs.writeFile(operatorFile, "operator-owned\n");

    await expect(
      createGitBackup({ repositoryPath, stateDir, databases: [database] }),
    ).rejects.toThrow(/repository must be dedicated to OpenClaw backups/u);
    await expect(fs.readFile(operatorFile, "utf8")).resolves.toBe("operator-owned\n");
  });

  it("removes stale backup-owned agent scopes for an all-database backup", async () => {
    const root = await tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    const staleAgentPath = path.join(repositoryPath, "agents", "old-agent");
    await initializeGitBackupRepository({ repositoryPath, stateDir });
    await writeBackupManifest(staleAgentPath, "old-agent");

    await createGitBackup({ repositoryPath, stateDir, databases: [database], all: true });

    await expect(fs.lstat(staleAgentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts all-database cleanup before deleting an unowned agent scope", async () => {
    const root = await tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    const ownedAgentPath = path.join(repositoryPath, "agents", "owned-agent");
    const unownedFile = path.join(repositoryPath, "agents", "operator", "operator.txt");
    await initializeGitBackupRepository({ repositoryPath, stateDir });
    await writeBackupManifest(ownedAgentPath, "owned-agent");
    await fs.mkdir(path.dirname(unownedFile), { recursive: true });
    await fs.writeFile(unownedFile, "operator-owned\n");

    await expect(
      createGitBackup({ repositoryPath, stateDir, databases: [database], all: true }),
    ).rejects.toThrow(/repository must be dedicated to OpenClaw backups/u);
    await expect(fs.readFile(unownedFile, "utf8")).resolves.toBe("operator-owned\n");
    await expect(
      fs.readFile(path.join(ownedAgentPath, "manifest.json"), "utf8"),
    ).resolves.toContain('"schemaVersion":1');
  });

  it.skipIf(process.platform === "win32")(
    "rejects group-writable adopted roots with a chmod hint",
    async () => {
      const root = await tempRoot();
      const stateDir = path.join(root, "state");
      const repositoryPath = path.join(root, "repository");
      await fs.mkdir(stateDir);
      await fs.mkdir(repositoryPath, { mode: 0o700 });
      await fs.chmod(repositoryPath, 0o770);

      await expect(initializeGitBackupRepository({ repositoryPath, stateDir })).rejects.toThrow(
        /chmod 700/u,
      );
    },
  );

  it("accepts a private adopted root", async () => {
    const root = await tempRoot();
    const stateDir = path.join(root, "state");
    const repositoryPath = path.join(root, "repository");
    await fs.mkdir(stateDir);
    await fs.mkdir(repositoryPath, { mode: 0o700 });

    await expect(initializeGitBackupRepository({ repositoryPath, stateDir })).resolves.toEqual({
      repositoryPath,
    });
  });

  it("uses a commit-scoped fallback identity when Git has no configured email", async () => {
    const root = await tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "identity-free-repository");
    const isolatedHome = path.join(root, "git-home");
    await fs.mkdir(isolatedHome, { recursive: true });
    const gitEnv = createPathResolutionEnv(isolatedHome, {
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });

    const result = await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [database],
      gitEnv,
    });

    expect(result.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(
      await requireGit(repositoryPath, ["log", "-1", "--format=%an <%ae>"], { env: gitEnv }),
    ).toBe("OpenClaw <backup@openclaw.local>");
    expect(
      await requireGit(repositoryPath, ["config", "--local", "--get", "user.email"], {
        env: gitEnv,
      }).catch(() => undefined),
    ).toBeUndefined();
  });

  it("redacts and bounds credential-bearing push diagnostics", async () => {
    const root = await tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "push-repository");
    const username = ["synthetic", "user"].join("-");
    const password = ["synthetic", "password"].join("-");
    const remote = `https://${username}:${password}@example.invalid/repository`;
    mocks.pushDiagnostic = `fatal: unable to access '${remote}': ${"x".repeat(600)}`;
    await initializeGitBackupRepository({ repositoryPath, stateDir, remote });
    await requireGit(repositoryPath, ["config", "user.name", "OpenClaw Backup Test"]);
    await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);

    const result = await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [database],
      push: true,
    });

    expect(result.pushWarning).toContain("https://***@example.invalid/repository");
    expect(result.pushWarning).not.toContain(username);
    expect(result.pushWarning).not.toContain(password);
    expect(result.pushWarning?.length).toBeLessThanOrEqual(500);
  });

  it("refuses adopted non-backup ancestry and records local push degradation", async () => {
    const root = await tempRoot();
    const { stateDir } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "adopted-repository");
    const remotePath = path.join(root, "remote.git");
    await requireGit(root, ["init", "--bare", remotePath]);
    await initializeGitBackupRepository({ repositoryPath, stateDir, remote: remotePath });
    await requireGit(repositoryPath, ["config", "user.name", "OpenClaw Backup Test"]);
    await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);
    await fs.writeFile(path.join(repositoryPath, "unrelated.txt"), "operator-owned\n");
    await requireGit(repositoryPath, ["add", "unrelated.txt"]);
    await requireGit(repositoryPath, ["commit", "-m", "operator history"]);

    const warning =
      "repository history contains non-backup commits; use a dedicated backup repository";
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const result = await backupGitCreateCommand(createTestRuntime(), {
        repository: repositoryPath,
        global: true,
        push: true,
        excludeSecrets: true,
      });

      expect(result).toMatchObject({ noChanges: false, pushed: false, pushWarning: warning });
      expect(result.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(readBackupFreshness(process.env)).toMatchObject({
        latest: { status: "ok", kind: "git", pushFailed: true, error: warning },
        latestOk: { status: "ok", kind: "git", pushFailed: true, error: warning },
      });
    });
    expect((await executeGitCommand(root, ["--git-dir", remotePath, "show-ref"])).code).not.toBe(0);
  });

  it("pushes backup-only ancestry to a new remote", async () => {
    const root = await tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "backup-repository");
    const remotePath = path.join(root, "remote.git");
    await requireGit(root, ["init", "--bare", remotePath]);
    await initializeGitBackupRepository({ repositoryPath, stateDir, remote: remotePath });
    await requireGit(repositoryPath, ["config", "user.name", "OpenClaw Backup Test"]);
    await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);

    const result = await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [database],
      push: true,
    });

    const branch = await requireGit(repositoryPath, ["branch", "--show-current"]);
    expect(result).toMatchObject({ noChanges: false, pushed: true });
    expect(result).not.toHaveProperty("pushWarning");
    expect(
      await requireGit(root, ["--git-dir", remotePath, "rev-parse", `refs/heads/${branch}`]),
    ).toBe(result.commit);
  });

  it("redacts credential-bearing origins in conflict errors", async () => {
    const root = await tempRoot();
    const stateDir = path.join(root, "state");
    const repositoryPath = path.join(root, "repository");
    const username = ["synthetic", "origin-user"].join("-");
    const password = ["synthetic", "origin-password"].join("-");
    await fs.mkdir(stateDir);
    await initializeGitBackupRepository({
      repositoryPath,
      stateDir,
      remote: `https://${username}:${password}@example.invalid/first`,
    });

    const conflict = initializeGitBackupRepository({
      repositoryPath,
      stateDir,
      remote: "https://example.invalid/second",
    });
    await expect(conflict).rejects.toThrow(
      "Git backup repository already has a different origin: https://***@example.invalid/first",
    );
    await expect(conflict).rejects.not.toThrow(username);
    await expect(conflict).rejects.not.toThrow(password);
  });

  it("round-trips losslessly, converges FTS, and omits derived vec and transcript state", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source.sqlite");
    const dump = path.join(root, "dump");
    const restoredPath = path.join(root, "restored.sqlite");
    await createFormatFixture(source);
    const manifest = await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: dump,
      identity: { role: "global" },
    });
    const restored = await restoreGitBackupDirectory({
      sourcePath: dump,
      targetPath: restoredPath,
      expectedIdentity: { role: "global" },
    });
    expect(restored.tables.every((table) => table.ok)).toBe(true);
    expect(restored.manifest.tables).toEqual(manifest.tables);
    expect(manifest.tables).not.toHaveProperty("session_transcript_index_state");
    if (process.platform !== "win32") {
      expect((await fs.stat(restoredPath)).mode & 0o777).toBe(0o600);
    }

    const database = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      const statement = database.prepare(
        "SELECT id, huge, bytes, optional FROM content ORDER BY id",
      );
      statement.setReadBigInts(true);
      const rows = statement.all() as Array<{
        id: bigint;
        huge: bigint;
        bytes: Uint8Array;
        optional: string | null;
      }>;
      expect(
        rows.map((row) => ({
          id: row.id,
          huge: row.huge,
          bytes: [...row.bytes],
          optional: row.optional,
        })),
      ).toEqual([
        {
          id: 1n,
          huge: 9_007_199_254_740_993n,
          bytes: [0, 1, 254, 255],
          optional: "",
        },
        { id: 2n, huge: -9_007_199_254_740_994n, bytes: [42], optional: null },
      ]);
      expect(
        database.prepare("SELECT rowid FROM content_fts WHERE content_fts MATCH 'lobster'").all(),
      ).toEqual([{ rowid: 1 }]);
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.some((table) => table.name === "memory_vec")).toBe(false);
      expect(tables.some((table) => table.name === "session_transcript_index_state")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("omits secret tables and reports the restore gap", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source.sqlite");
    const dump = path.join(root, "dump");
    await createFormatFixture(source);
    const manifest = await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: dump,
      identity: { role: "global" },
      excludeSecrets: true,
    });
    expect(manifest.excludedTables).toContain("device_auth_tokens");
    expect(manifest.excludedTables).toContain("channel_pairing_requests");
    expect(manifest.excludedTables).toContain("device_pairing_join_codes");
    expect(manifest.tables).not.toHaveProperty("device_auth_tokens");
    expect(manifest.tables).not.toHaveProperty("channel_pairing_requests");
    expect(manifest.tables).not.toHaveProperty("device_pairing_join_codes");
    await expect(
      fs.lstat(path.join(dump, "tables", "channel_pairing_requests.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.lstat(path.join(dump, "tables", "device_pairing_join_codes.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const schema = await fs.readFile(path.join(dump, "schema.sql"), "utf8");
    expect(schema).not.toContain("device_auth_tokens");
    expect(schema).not.toContain("channel_pairing_requests");
    expect(schema).not.toContain("device_pairing_join_codes");
    const restored = await restoreGitBackupDirectory({
      sourcePath: dump,
      targetPath: path.join(root, "redacted.sqlite"),
    });
    expect(restored.excludedTables).toContain("device_auth_tokens");
    const restoredDatabase = new DatabaseSync(restored.targetPath, { readOnly: true });
    try {
      expect(
        restoredDatabase.prepare("SELECT COUNT(*) AS count FROM device_auth_tokens").get(),
      ).toEqual({ count: 0 });
      expect(
        restoredDatabase.prepare("SELECT COUNT(*) AS count FROM channel_pairing_requests").get(),
      ).toEqual({ count: 0 });
    } finally {
      restoredDatabase.close();
    }
  });

  it("redacts secret machine-state keys while retaining ordinary machine state", async () => {
    const root = await tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const nodeSecret = "synthetic-node-host-gateway-secret";
    const pushSecret = "synthetic-web-push-private-key";
    writeConfigMachineState("nodeHost.config", { gateway: { token: nodeSecret } }, { env });
    writeConfigMachineState("nodeHost.otherSecret", { token: nodeSecret }, { env });
    writeConfigMachineState("webPush.vapidKeys", { privateKey: pushSecret }, { env });
    const authSecret = "synthetic-shared-auth-profile-secret";
    writeConfigMachineState("authProfiles.store", { profiles: { openai: authSecret } }, { env });
    writeConfigMachineState("authProfiles.state", { active: authSecret }, { env });
    writeConfigMachineState("sidebar.sectionOrder", ["first", "second"], { env });
    closeOpenClawStateDatabaseForTest();

    const outputPath = path.join(root, "dump");
    const manifest = await dumpGitBackupDatabase({
      snapshotPath: database.path,
      outputPath,
      identity: { role: "global" },
      excludeSecrets: true,
    });
    const rows = await fs.readFile(
      path.join(outputPath, "tables", "config_machine_state.jsonl"),
      "utf8",
    );
    const manifestJson = await fs.readFile(path.join(outputPath, "manifest.json"), "utf8");

    expect(manifest).toMatchObject({
      excludedConfigStateKeyPrefixes: ["authProfiles.", "nodeHost.", "webPush.vapidKeys"],
      tables: { config_machine_state: { rows: 1 } },
    });
    expect(rows).toContain("sidebar.sectionOrder");
    expect(rows).toContain("first");
    expect(rows).not.toContain("nodeHost.");
    expect(rows).not.toContain("webPush.vapidKeys");
    expect(rows).not.toContain(nodeSecret);
    expect(rows).not.toContain("authProfiles.");
    expect(rows).not.toContain(authSecret);
    expect(rows).not.toContain(pushSecret);
    expect(manifestJson).not.toContain(nodeSecret);
    expect(manifestJson).not.toContain(pushSecret);
    expect(manifestJson).not.toContain(authSecret);

    const restoredPath = path.join(root, "restored.sqlite");
    const restored = await restoreGitBackupDirectory({
      sourcePath: outputPath,
      targetPath: restoredPath,
      expectedIdentity: { role: "global" },
    });
    // Restore must disclose the intentionally omitted machine-state prefixes so
    // operators cannot mistake a redacted restore for a complete one.
    expect(restored.excludedConfigStateKeyPrefixes).toEqual([
      "authProfiles.",
      "nodeHost.",
      "webPush.vapidKeys",
    ]);
  });

  it("rejects a restored global database without canonical ownership metadata", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source.sqlite");
    const dump = path.join(root, "dump");
    const restoredPath = path.join(root, "restored.sqlite");
    await createFormatFixture(source);
    const database = new DatabaseSync(source);
    try {
      database.exec("DROP TABLE schema_meta;");
    } finally {
      database.close();
    }
    await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: dump,
      identity: { role: "global" },
    });

    await expect(
      restoreGitBackupDirectory({
        sourcePath: dump,
        targetPath: restoredPath,
        expectedIdentity: { role: "global" },
      }),
    ).rejects.toThrow(/schema role missing; expected global/u);
    await expect(fs.lstat(restoredPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converges and validates the requested agent database owner", async () => {
    const root = await tempRoot();
    const source = path.join(root, "agent.sqlite");
    const dump = path.join(root, "dump");
    const restoredPath = path.join(root, "restored.sqlite");
    createAgentFixture(source, "main");
    await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: dump,
      identity: { role: "agent", agentId: "main" },
    });

    await restoreGitBackupDirectory({
      sourcePath: dump,
      targetPath: restoredPath,
      expectedIdentity: { role: "agent", agentId: "main" },
    });
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      expect(
        restored.prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ role: "agent", agent_id: "main" });
      expect(
        restored.prepare("SELECT COUNT(*) AS count FROM session_transcript_index_state").get(),
      ).toEqual({ count: 0 });
    } finally {
      restored.close();
    }
  });
});
