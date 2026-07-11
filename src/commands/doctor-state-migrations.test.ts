// Doctor state migration tests cover legacy state moves, archive markers, and repair behavior.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
  setMaxPluginStateEntriesPerPluginForTests,
} from "../plugin-state/plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "../plugin-state/plugin-state-store.test-helpers.js";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginInstallRecordInfo } from "../plugins/installed-plugin-index.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { loadTaskFlowRegistryStateFromSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import { loadTaskRegistryStateFromSqlite } from "../tasks/task-registry.store.sqlite.js";
import {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyState,
  autoMigrateLegacyTaskStateSidecars,
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyStateForTest,
  resetAutoMigrateLegacyTaskStateSidecarsForTest,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";

let tempRoots: string[] = [];

const mockedChannelMigrationPlans = vi.hoisted(() => ({
  plans: [] as Array<Record<string, unknown>>,
}));

vi.mock("../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/bundled.js")>(
    "../channels/plugins/bundled.js",
  );
  function fileExists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  function resolveTelegramAccountId(cfg: OpenClawConfig): string {
    const defaultAgentId = cfg.agents?.list?.find((agent) => agent.default)?.id ?? "main";
    const boundAccountId = cfg.bindings?.find(
      (binding) =>
        binding.agentId === defaultAgentId &&
        binding.match?.channel === "telegram" &&
        typeof binding.match.accountId === "string",
    )?.match.accountId;
    return boundAccountId ?? cfg.channels?.telegram?.defaultAccount ?? "default";
  }

  function detectTelegramAllowFromMigration(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
  }) {
    const root = params.env.OPENCLAW_STATE_DIR;
    if (!root) {
      return [];
    }
    const legacyPath = path.join(root, "credentials", "telegram-allowFrom.json");
    if (!fileExists(legacyPath)) {
      return [];
    }
    const targetPath = path.join(
      root,
      "credentials",
      `telegram-${resolveTelegramAccountId(params.cfg)}-allowFrom.json`,
    );
    return fileExists(targetPath)
      ? []
      : [
          {
            kind: "copy" as const,
            label: "Telegram pairing allowFrom",
            sourcePath: legacyPath,
            targetPath,
          },
        ];
  }

  function detectWhatsAppLegacyStateMigrations(params: { oauthDir: string }) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(params.oauthDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const isLegacyAuthFile =
        entry.name === "creds.json" ||
        entry.name === "creds.json.bak" ||
        (/^(app-state-sync|session|sender-key|pre-key)-/.test(entry.name) &&
          entry.name.endsWith(".json"));
      if (!entry.isFile() || entry.name === "oauth.json" || !isLegacyAuthFile) {
        return [];
      }
      const sourcePath = path.join(params.oauthDir, entry.name);
      const targetPath = path.join(params.oauthDir, "whatsapp", "default", entry.name);
      return fileExists(targetPath)
        ? []
        : [{ kind: "move" as const, label: `WhatsApp auth ${entry.name}`, sourcePath, targetPath }];
    });
  }

  return {
    ...actual,
    listBundledChannelLegacySessionSurfaces: vi.fn(() => [
      {
        isLegacyGroupSessionKey: (key: string) => /^group:.+@g\.us$/i.test(key.trim()),
        canonicalizeLegacySessionKey: ({ key, agentId }: { key: string; agentId: string }) =>
          /^group:.+@g\.us$/i.test(key.trim())
            ? `agent:${agentId}:whatsapp:${key.trim().toLowerCase()}`
            : null,
      },
    ]),
    listBundledChannelLegacyStateMigrationDetectors: vi.fn(() => [
      ({ oauthDir }: { oauthDir: string }) => detectWhatsAppLegacyStateMigrations({ oauthDir }),
      ({ cfg, env }: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv }) =>
        detectTelegramAllowFromMigration({ cfg, env }),
      () => mockedChannelMigrationPlans.plans,
    ]),
  };
});

vi.mock("../config/sessions.js", () => ({
  saveSessionStore: async (storePath: string, store: Record<string, unknown>) => {
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    await fs.promises.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  },
}));

vi.mock("../infra/json-files.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/json-files.js")>("../infra/json-files.js");
  return {
    ...actual,
    writeTextAtomic: async (
      filePath: string,
      content: string,
      options?: { mode?: number; dirMode?: number; trailingNewline?: boolean },
    ) => {
      const payload =
        options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
      await fs.promises.mkdir(path.dirname(filePath), {
        recursive: true,
        ...(typeof options?.dirMode === "number" ? { mode: options.dirMode } : {}),
      });
      await fs.promises.writeFile(filePath, payload, {
        encoding: "utf8",
        mode: options?.mode ?? 0o600,
      });
    },
  };
});

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  collectRelevantDoctorPluginIds: vi.fn(() => []),
  listPluginDoctorSessionStoreAgentIds: vi.fn(() => []),
  listPluginDoctorStateMigrationEntries: vi.fn(() => []),
}));

async function makeTempRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-"));
  tempRoots.push(root);
  return root;
}

async function makeRootWithEmptyCfg() {
  const root = await makeTempRoot();
  const cfg: OpenClawConfig = {};
  return { root, cfg };
}

function writeLegacyTelegramAllowFromStore(oauthDir: string) {
  fs.writeFileSync(
    path.join(oauthDir, "telegram-allowFrom.json"),
    JSON.stringify(
      {
        version: 1,
        allowFrom: ["123456"],
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

async function runTelegramAllowFromMigration(params: { root: string; cfg: OpenClawConfig }) {
  const oauthDir = ensureCredentialsDir(params.root);
  writeLegacyTelegramAllowFromStore(oauthDir);
  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    env: { OPENCLAW_STATE_DIR: params.root } as NodeJS.ProcessEnv,
  });
  const result = await runLegacyStateMigrations({ detected, now: () => 123 });
  return { oauthDir, detected, result };
}

afterEach(async () => {
  resetAutoMigrateLegacyStateForTest();
  resetAutoMigrateLegacyStateDirForTest();
  resetAutoMigrateLegacyTaskStateSidecarsForTest();
  closeOpenClawStateDatabaseForTest();
  setMaxPluginStateEntriesPerPluginForTests();
  resetPluginStateStoreForTests();
  mockedChannelMigrationPlans.plans = [];
  await Promise.all(
    tempRoots.map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
  tempRoots = [];
});

function writeJson5(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readPrimaryKeyColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: unknown;
    pk?: unknown;
  }>;
  return rows
    .filter((row) => Number(row.pk ?? 0) > 0 && typeof row.name === "string")
    .toSorted((left, right) => Number(left.pk ?? 0) - Number(right.pk ?? 0))
    .map((row) => row.name as string);
}

function createLegacyAgentDatabaseRegistry(stateDir: string): string {
  const stateDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(stateDatabasePath);
  try {
    db.exec(`
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        size_bytes INTEGER
      );
      INSERT INTO agent_databases (
        agent_id,
        path,
        schema_version,
        last_seen_at,
        size_bytes
      ) VALUES (
        'worker-1',
        '/legacy/worker-1/openclaw-agent.sqlite',
        1,
        10,
        20
      );
    `);
  } finally {
    db.close();
  }
  return stateDatabasePath;
}

function writeLegacySessionsFixture(params: {
  root: string;
  sessions: Record<string, Record<string, unknown> & { sessionId: string; updatedAt: number }>;
  transcripts?: Record<string, string>;
}) {
  const legacySessionsDir = path.join(params.root, "sessions");
  fs.mkdirSync(legacySessionsDir, { recursive: true });
  writeJson5(path.join(legacySessionsDir, "sessions.json"), params.sessions);
  for (const [fileName, content] of Object.entries(params.transcripts ?? {})) {
    fs.writeFileSync(path.join(legacySessionsDir, fileName), content, "utf-8");
  }
  return legacySessionsDir;
}

function writeLegacyPluginStateSidecar(root: string): string {
  const sourcePath = path.join(root, "plugin-state", "state.sqlite");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sourcePath);
  try {
    db.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      );
    `);
    db.prepare(`
      INSERT INTO plugin_state_entries (
        plugin_id, namespace, entry_key, value_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("discord", "components", "interaction:1", '{"ok":true}', 1000, null);
  } finally {
    db.close();
  }
  return sourcePath;
}

function writeLegacyDebugProxyCaptureSidecar(
  root: string,
  overrides: { sourcePath?: string; blobDir?: string } = {},
): {
  sourcePath: string;
  blobDir: string;
  blobId: string;
} {
  const sourcePath = overrides.sourcePath ?? path.join(root, "debug-proxy", "capture.sqlite");
  const blobDir = overrides.blobDir ?? path.join(root, "debug-proxy", "blobs");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(blobDir, { recursive: true });
  const payload = Buffer.from('{"legacy":true}');
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const blobId = sha256.slice(0, 24);
  fs.writeFileSync(path.join(blobDir, `${blobId}.bin.gz`), gzipSync(payload));
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sourcePath);
  try {
    db.exec(`
      CREATE TABLE capture_sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        mode TEXT NOT NULL,
        source_scope TEXT NOT NULL,
        source_process TEXT NOT NULL,
        proxy_url TEXT,
        db_path TEXT NOT NULL,
        blob_dir TEXT NOT NULL
      );
      CREATE TABLE capture_events (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        source_scope TEXT NOT NULL,
        source_process TEXT NOT NULL,
        protocol TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        method TEXT,
        host TEXT,
        path TEXT,
        status INTEGER,
        close_code INTEGER,
        content_type TEXT,
        headers_json TEXT,
        data_text TEXT,
        data_blob_id TEXT,
        data_sha256 TEXT,
        error_text TEXT,
        meta_json TEXT
      );
    `);
    db.prepare(
      `INSERT INTO capture_sessions (
        id, started_at, ended_at, mode, source_scope, source_process, proxy_url, db_path, blob_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-session",
      100,
      200,
      "proxy-run",
      "openclaw",
      "openclaw",
      "http://127.0.0.1:8080",
      sourcePath,
      blobDir,
    );
    db.prepare(
      `INSERT INTO capture_events (
        session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
        method, host, path, status, close_code, content_type, headers_json, data_text,
        data_blob_id, data_sha256, error_text, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-session",
      150,
      "openclaw",
      "openclaw",
      "https",
      "outbound",
      "request",
      "legacy-flow",
      "POST",
      "api.example.com",
      "/v1/test",
      null,
      null,
      "application/json",
      '{"content-type":"application/json"}',
      '{"legacy":true}',
      blobId,
      sha256,
      null,
      '{"provider":"test"}',
    );
  } finally {
    db.close();
  }
  return { sourcePath, blobDir, blobId };
}

async function writeExistingPluginInstallIndex(
  root: string,
  installRecords: Record<string, InstalledPluginInstallRecordInfo>,
): Promise<void> {
  await writePersistedInstalledPluginIndex(
    {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 1,
      installRecords,
      plugins: [],
      diagnostics: [],
    },
    { stateDir: root },
  );
}

function writeLegacyPluginInstallIndex(
  root: string,
  records: Record<string, InstalledPluginInstallRecordInfo>,
): string {
  const sourcePath = path.join(root, "plugins", "installs.json");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ records }), "utf8");
  return sourcePath;
}

async function runLegacyStateMigrationsForRoot(root: string) {
  const detected = await detectLegacyStateMigrations({
    cfg: {},
    env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
  });
  return await runLegacyStateMigrations({ detected });
}

function failRenameOnce(sourcePath: string) {
  const actualRenameSync = fs.renameSync.bind(fs);
  let failed = false;
  return vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (!failed && String(from) === sourcePath) {
      failed = true;
      throw new Error("forced archive failure");
    }
    actualRenameSync(from, to);
  });
}

function writePendingWalSnapshot(sourcePath: string, mutate: (db: DatabaseSync) => void): Buffer {
  const walPath = `${sourcePath}-wal`;
  const snapshotPath = `${sourcePath}.wal-snapshot`;
  const snapshotWalPath = `${snapshotPath}-wal`;
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sourcePath);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    mutate(db);
    // Copy before closing because SQLite checkpoints and removes the WAL on clean shutdown.
    fs.copyFileSync(sourcePath, snapshotPath);
    fs.copyFileSync(walPath, snapshotWalPath);
  } finally {
    db.close();
  }
  for (const suffix of ["", "-shm", "-wal", "-journal"]) {
    fs.rmSync(`${sourcePath}${suffix}`, { force: true });
  }
  fs.renameSync(snapshotPath, sourcePath);
  fs.renameSync(snapshotWalPath, walPath);
  return fs.readFileSync(walPath);
}

function writeLegacyTaskStateSidecars(root: string): {
  taskRunsPath: string;
  flowRunsPath: string;
} {
  const taskRunsPath = path.join(root, "tasks", "runs.sqlite");
  fs.mkdirSync(path.dirname(taskRunsPath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const tasksDb = new sqlite.DatabaseSync(taskRunsPath);
  try {
    tasksDb.exec(`
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_id TEXT,
        requester_session_key TEXT NOT NULL,
        child_session_key TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
    `);
    tasksDb
      .prepare(
        `
          INSERT INTO task_runs (
            task_id, runtime, source_id, requester_session_key, child_session_key, agent_id, run_id,
            task, status, delivery_status, notify_policy, created_at, last_event_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "legacy-task",
        "cron",
        "nightly",
        "",
        "agent:main:cron:nightly",
        "ops",
        "legacy-task-run",
        "Legacy cron task",
        "running",
        "not_applicable",
        "silent",
        100,
        110,
      );
    tasksDb
      .prepare(
        `
          INSERT INTO task_delivery_state (
            task_id, requester_origin_json, last_notified_event_at
          ) VALUES (?, ?, ?)
        `,
      )
      .run("legacy-task", '{"channel":"test","to":"target"}', 120);
  } finally {
    tasksDb.close();
  }

  const flowRunsPath = path.join(root, "flows", "registry.sqlite");
  fs.mkdirSync(path.dirname(flowRunsPath), { recursive: true });
  const flowsDb = new sqlite.DatabaseSync(flowRunsPath);
  try {
    flowsDb.exec(`
      CREATE TABLE flow_runs (
        flow_id TEXT PRIMARY KEY,
        owner_session_key TEXT NOT NULL,
        requester_origin_json TEXT,
        status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        goal TEXT NOT NULL,
        current_step TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER
      );
    `);
    flowsDb
      .prepare(
        `
          INSERT INTO flow_runs (
            flow_id, owner_session_key, status, notify_policy, goal, current_step, created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "legacy-flow",
        "agent:main:legacy-flow",
        "running",
        "done_only",
        "Legacy flow",
        "spawn_task",
        200,
        210,
      );
  } finally {
    flowsDb.close();
  }

  return { taskRunsPath, flowRunsPath };
}

function appendLegacyCrossAgentTask(taskRunsPath: string): void {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(taskRunsPath);
  try {
    db.prepare(
      `
        INSERT INTO task_runs (
          task_id, runtime, requester_session_key, child_session_key, agent_id, run_id, task,
          status, delivery_status, notify_policy, created_at, last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "legacy-cross-agent",
      "subagent",
      "agent:main:main",
      "agent:worker:subagent:child",
      "main",
      "legacy-cross-agent-run",
      "Inspect worker state",
      "running",
      "pending",
      "done_only",
      130,
      140,
    );
  } finally {
    db.close();
  }
}

function appendLegacyTaskWithObsoleteDeliveryStatus(taskRunsPath: string): void {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(taskRunsPath);
  try {
    db.prepare(
      `
        INSERT INTO task_runs (
          task_id, runtime, requester_session_key, agent_id, run_id, task,
          status, delivery_status, notify_policy, created_at, last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "legacy-not-requested",
      "cron",
      "",
      "ops",
      "legacy-not-requested-run",
      "Legacy cancelled task",
      "cancelled",
      "not-requested",
      "silent",
      150,
      160,
    );
  } finally {
    db.close();
  }
}

async function detectAndRunMigrations(params: {
  root: string;
  cfg: OpenClawConfig;
  now?: () => number;
}) {
  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    env: { OPENCLAW_STATE_DIR: params.root } as NodeJS.ProcessEnv,
  });
  await runLegacyStateMigrations({ detected, now: params.now });
}

async function withStateDir<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

function readSessionsStore(targetDir: string) {
  return JSON.parse(fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8")) as Record<
    string,
    { sessionId: string }
  >;
}

async function runAndReadSessionsStore(params: {
  root: string;
  cfg: OpenClawConfig;
  targetDir: string;
  now?: () => number;
}) {
  await detectAndRunMigrations({
    root: params.root,
    cfg: params.cfg,
    now: params.now,
  });
  return readSessionsStore(params.targetDir);
}

type StateDirMigrationResult = Awaited<ReturnType<typeof autoMigrateLegacyStateDir>>;

const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function getStateDirMigrationPaths(root: string) {
  return {
    targetDir: path.join(root, ".openclaw"),
    legacyDir: path.join(root, ".clawdbot"),
  };
}

function ensureLegacyAndTargetStateDirs(root: string) {
  const paths = getStateDirMigrationPaths(root);
  fs.mkdirSync(paths.targetDir, { recursive: true });
  fs.mkdirSync(paths.legacyDir, { recursive: true });
  return paths;
}

async function runStateDirMigration(root: string, env = {} as NodeJS.ProcessEnv) {
  return autoMigrateLegacyStateDir({
    env,
    homedir: () => root,
  });
}

async function runFreshStateDirMigration(root: string, env = {} as NodeJS.ProcessEnv) {
  resetAutoMigrateLegacyStateDirForTest();
  return runStateDirMigration(root, env);
}

async function runAutoMigrateLegacyStateWithLog(params: {
  root: string;
  cfg: OpenClawConfig;
  now?: () => number;
}) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const result = await autoMigrateLegacyState({
    cfg: params.cfg,
    env: { OPENCLAW_STATE_DIR: params.root } as NodeJS.ProcessEnv,
    log,
    now: params.now,
  });
  return { result, log };
}

function expectTargetAlreadyExistsWarning(result: StateDirMigrationResult, targetDir: string) {
  expect(result.migrated).toBe(false);
  expect(result.warnings).toEqual([
    `State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`,
  ]);
}

function expectUnmigratedWithoutWarnings(result: StateDirMigrationResult) {
  expect(result.migrated).toBe(false);
  expect(result.warnings).toStrictEqual([]);
}

function writeLegacyAgentFiles(root: string, files: Record<string, string>) {
  const legacyAgentDir = path.join(root, "agent");
  fs.mkdirSync(legacyAgentDir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(legacyAgentDir, fileName), content, "utf-8");
  }
  return legacyAgentDir;
}

function ensureCredentialsDir(root: string) {
  const oauthDir = path.join(root, "credentials");
  fs.mkdirSync(oauthDir, { recursive: true });
  return oauthDir;
}

describe("doctor legacy state migrations", () => {
  let migratedLegacySessionsCase: {
    result: Awaited<ReturnType<typeof runLegacyStateMigrations>>;
    targetDir: string;
    legacySessionsDir: string;
    store: Record<string, { sessionId: string; sessionFile?: string }>;
  };

  beforeAll(async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const legacySessionsDir = writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": {
          sessionId: "a",
          sessionFile: path.join(root, "sessions", "a.jsonl"),
          updatedAt: 10,
        },
        "+1666": { sessionId: "b", sessionFile: "b.jsonl", updatedAt: 20 },
        "slack:channel:C123": { sessionId: "c", updatedAt: 30 },
        "group:abc": { sessionId: "d", updatedAt: 40 },
        "subagent:xyz": { sessionId: "e", updatedAt: 50 },
      },
      transcripts: {
        "a.jsonl": "a",
        "b.jsonl": "b",
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });
    const targetDir = path.join(root, "agents", "main", "sessions");
    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string; sessionFile?: string }>;

    migratedLegacySessionsCase = { result, targetDir, legacySessionsDir, store };
  });

  it("migrates legacy sessions into agents/<id>/sessions", () => {
    expect(migratedLegacySessionsCase.result.warnings).toStrictEqual([]);
    const { targetDir, legacySessionsDir, store } = migratedLegacySessionsCase;
    expect(fs.existsSync(path.join(targetDir, "a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "b.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(legacySessionsDir, "a.jsonl"))).toBe(false);

    expect(store["agent:main:main"]?.sessionId).toBe("b");
    expect(store["agent:main:+1555"]?.sessionId).toBe("a");
    expect(store["agent:main:+1666"]?.sessionId).toBe("b");
    expect(store["agent:main:+1555"]?.sessionFile).toBe(path.join(targetDir, "a.jsonl"));
    expect(store["agent:main:+1666"]?.sessionFile).toBe(path.join(targetDir, "b.jsonl"));
    expect(store["+1555"]).toBeUndefined();
    expect(store["+1666"]).toBeUndefined();
    expect(store["agent:main:slack:channel:c123"]?.sessionId).toBe("c");
    expect(store["agent:main:unknown:group:abc"]?.sessionId).toBe("d");
    expect(store["agent:main:subagent:xyz"]?.sessionId).toBe("e");
  });

  it("repairs stale transcript paths left by a shipped legacy migration", async () => {
    const root = await makeTempRoot();
    const legacyDir = path.join(root, "sessions");
    const targetDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, "legacy.jsonl"),
      '{"type":"session","id":"legacy"}\n',
      "utf8",
    );
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": {
        sessionId: "legacy",
        sessionFile: path.join(legacyDir, "legacy.jsonl"),
        updatedAt: 10,
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.preview).toContain(
      `- Sessions: repair migrated transcript paths in ${path.join(targetDir, "sessions.json")}`,
    );

    const result = await runLegacyStateMigrations({ detected });
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Repaired migrated session transcript paths");
    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf8"),
    ) as Record<string, { sessionFile?: string }>;
    expect(store["agent:main:main"]?.sessionFile).toBe(path.join(targetDir, "legacy.jsonl"));
  });

  it("does not bind stale session metadata to a colliding target transcript", async () => {
    const root = await makeTempRoot();
    const legacyDir = path.join(root, "sessions");
    const targetDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, "legacy.jsonl"),
      '{"type":"session","id":"other"}\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(targetDir, "legacy.legacy-123.jsonl"),
      '{"type":"session","id":"legacy"}\n',
      "utf8",
    );
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": {
        sessionId: "legacy",
        sessionFile: path.join(legacyDir, "legacy.jsonl"),
        updatedAt: 10,
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.sessions.hasLegacy).toBe(false);
    expect(detected.preview).not.toContain(
      `- Sessions: repair migrated transcript paths in ${path.join(targetDir, "sessions.json")}`,
    );
  });

  it("tolerates malformed session-store entries during stale-path detection", async () => {
    const root = await makeTempRoot();
    const targetDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(targetDir, { recursive: true });
    writeJson5(path.join(targetDir, "sessions.json"), { broken: null });

    await expect(
      detectLegacyStateMigrations({
        cfg: {},
        env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
      }),
    ).resolves.toBeDefined();
  });

  it("repairs canonical headerless legacy transcript paths", async () => {
    const root = await makeTempRoot();
    const legacyDir = path.join(root, "sessions");
    const targetDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "legacy.jsonl"), '{"role":"user"}\n', "utf8");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": {
        sessionId: "legacy",
        sessionFile: path.join(legacyDir, "legacy.jsonl"),
        updatedAt: 10,
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.sessions.hasLegacy).toBe(true);
  });

  it("migrates the legacy shared state agent registry primary key", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, ".openclaw");
    const stateDatabasePath = createLegacyAgentDatabaseRegistry(stateDir);
    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: {} as NodeJS.ProcessEnv,
      homedir: () => root,
    });

    expect(detected.preview).toContain(
      "- Shared SQLite schema: agent database registry primary key → agent_id,path",
    );

    const result = await runLegacyStateMigrations({ detected });
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Migrated shared state agent database registry primary key → agent_id,path",
    ]);

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(stateDatabasePath);
    try {
      expect(readPrimaryKeyColumns(db, "agent_databases")).toEqual(["agent_id", "path"]);
      expect(() =>
        db.exec(`
          INSERT INTO agent_databases (
            agent_id,
            path,
            schema_version,
            last_seen_at,
            size_bytes
          ) VALUES (
            'worker-1',
            '/relocated/worker-1/openclaw-agent.sqlite',
            1,
            20,
            30
          )
          ON CONFLICT(agent_id, path) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            size_bytes = excluded.size_bytes;
        `),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("does not repair newer shared state schemas", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, ".openclaw");
    const stateDatabasePath = createLegacyAgentDatabaseRegistry(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const seededDb = new DatabaseSync(stateDatabasePath);
    seededDb.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    seededDb.close();

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: {} as NodeJS.ProcessEnv,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected });
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
    );

    const db = new DatabaseSync(stateDatabasePath);
    try {
      expect(readPrimaryKeyColumns(db, "agent_databases")).toEqual(["agent_id"]);
    } finally {
      db.close();
    }
  });

  it("migrates legacy ACP metadata from sessions.json into shared SQLite", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const legacySessionKey = "acp:binding:discord:default:feedface";
    const sessionKey = "agent:main:acp:binding:discord:default:feedface";
    writeLegacySessionsFixture({
      root,
      sessions: {
        [legacySessionKey]: {
          sessionId: "sess-acp",
          updatedAt: 100,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "codex-discord",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 123,
          },
        },
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({
      detected,
      config: cfg,
      now: () => 456,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.some((change) => change.includes("ACP session metadata"))).toBe(true);
    const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
    expect(store[legacySessionKey]?.acp).toBeUndefined();

    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    try {
      const row = db
        .prepare(
          "SELECT backend, agent, runtime_session_name, mode, state, last_activity_at FROM acp_sessions WHERE session_key = ?",
        )
        .get(sessionKey) as
        | {
            backend: string;
            agent: string;
            runtime_session_name: string;
            mode: string;
            state: string;
            last_activity_at: number | bigint;
          }
        | undefined;
      expect(row).toMatchObject({
        backend: "acpx",
        agent: "codex",
        runtime_session_name: "codex-discord",
        mode: "persistent",
        state: "idle",
      });
      expect(Number(row?.last_activity_at)).toBe(123);
      const legacyRow = db
        .prepare("SELECT session_key FROM acp_sessions WHERE session_key = ?")
        .get(legacySessionKey);
      expect(legacyRow).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("migrates legacy ACP metadata from retired custom-root agent stores", async () => {
    const root = await makeTempRoot();
    const customRoot = await makeTempRoot();
    const legacySessionKey = "acp:binding:discord:default:feedface";
    const sessionKey = "agent:ops:acp:binding:discord:default:feedface";
    const storePath = path.join(customRoot, "agents", "ops", "sessions", "sessions.json");
    const cfg: OpenClawConfig = {
      session: {
        store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    writeJson5(storePath, {
      [legacySessionKey]: {
        sessionId: "sess-acp",
        updatedAt: 100,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({
      detected,
      config: cfg,
      now: () => 456,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.some((change) => change.includes("ACP session metadata"))).toBe(true);
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
    expect(store[legacySessionKey]?.acp).toBeUndefined();

    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    try {
      const row = db
        .prepare(
          "SELECT backend, agent, runtime_session_name, mode, state, last_activity_at FROM acp_sessions WHERE session_key = ?",
        )
        .get(sessionKey) as
        | {
            backend: string;
            agent: string;
            runtime_session_name: string;
            mode: string;
            state: string;
            last_activity_at: number | bigint;
          }
        | undefined;
      expect(row).toMatchObject({
        backend: "acpx",
        agent: "codex",
        runtime_session_name: "codex-discord",
        mode: "persistent",
        state: "idle",
      });
      expect(Number(row?.last_activity_at)).toBe(123);
    } finally {
      db.close();
    }
  });

  it("skips symlinked managed-agent ACP metadata stores", async () => {
    const root = await makeTempRoot();
    const outsideRoot = await makeTempRoot();
    const sessionKey = "agent:main:acp:binding:discord:default:feedface";
    const managedStorePath = path.join(root, "agents", "main", "sessions", "sessions.json");
    const outsideStorePath = path.join(outsideRoot, "sessions.json");
    writeJson5(outsideStorePath, {
      [sessionKey]: {
        sessionId: "sess-acp",
        updatedAt: 100,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      },
    });
    fs.mkdirSync(path.dirname(managedStorePath), { recursive: true });
    fs.symlinkSync(outsideStorePath, managedStorePath);

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.some((change) => change.includes("ACP session metadata"))).toBe(false);
    const outsideStore = JSON.parse(fs.readFileSync(outsideStorePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    expect(outsideStore[sessionKey]?.acp).toBeDefined();
  });

  it("skips symlinked custom agent-store ACP metadata stores", async () => {
    const root = await makeTempRoot();
    const customRoot = await makeTempRoot();
    const outsideRoot = await makeTempRoot();
    const sessionKey = "agent:main:acp:binding:discord:default:feedface";
    const cfg: OpenClawConfig = {
      session: {
        store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    const managedStorePath = path.join(customRoot, "agents", "main", "sessions", "sessions.json");
    const outsideStorePath = path.join(outsideRoot, "sessions.json");
    writeJson5(outsideStorePath, {
      [sessionKey]: {
        sessionId: "sess-acp",
        updatedAt: 100,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      },
    });
    fs.mkdirSync(path.dirname(managedStorePath), { recursive: true });
    fs.symlinkSync(outsideStorePath, managedStorePath);

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.some((change) => change.includes("ACP session metadata"))).toBe(false);
    const outsideStore = JSON.parse(fs.readFileSync(outsideStorePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    expect(outsideStore[sessionKey]?.acp).toBeDefined();
  });

  it("keeps shipped WhatsApp legacy group keys channel-qualified during migration", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");

    writeLegacySessionsFixture({
      root,
      sessions: {
        "group:123@g.us": { sessionId: "wa", updatedAt: 10 },
        "group:abc": { sessionId: "generic", updatedAt: 9 },
      },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });

    expect(store["agent:main:whatsapp:group:123@g.us"]?.sessionId).toBe("wa");
    expect(store["agent:main:unknown:group:abc"]?.sessionId).toBe("generic");
  });

  it("migrates legacy agent dir with conflict fallback", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    writeLegacyAgentFiles(root, {
      "foo.txt": "legacy",
      "baz.txt": "legacy2",
    });

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    fs.mkdirSync(targetAgentDir, { recursive: true });
    fs.writeFileSync(path.join(targetAgentDir, "foo.txt"), "new", "utf-8");

    await detectAndRunMigrations({ root, cfg, now: () => 123 });

    expect(fs.readFileSync(path.join(targetAgentDir, "baz.txt"), "utf-8")).toBe("legacy2");
    const backupDir = path.join(root, "agents", "main", "agent.legacy-123");
    expect(fs.existsSync(path.join(backupDir, "foo.txt"))).toBe(true);
  });

  it("auto-migrates legacy agent dir on startup", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    writeLegacyAgentFiles(root, { "auth.json": "{}" });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({ root, cfg });

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    expect(fs.existsSync(path.join(targetAgentDir, "auth.json"))).toBe(true);
    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();
  });

  it("auto-migrates legacy sessions on startup", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const legacySessionsDir = writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
      },
      transcripts: {
        "a.jsonl": "a",
      },
    });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({
      root,
      cfg,
      now: () => 123,
    });

    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();

    const targetDir = path.join(root, "agents", "main", "sessions");
    expect(fs.existsSync(path.join(targetDir, "a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(legacySessionsDir, "a.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "sessions.json"))).toBe(true);
  });

  it("migrates legacy WhatsApp auth files without touching oauth.json", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const oauthDir = ensureCredentialsDir(root);
    fs.writeFileSync(path.join(oauthDir, "oauth.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "creds.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "session-abc.json"), "{}", "utf-8");

    await detectAndRunMigrations({ root, cfg, now: () => 123 });

    const target = path.join(oauthDir, "whatsapp", "default");
    expect(fs.existsSync(path.join(target, "creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "session-abc.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "oauth.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "creds.json"))).toBe(false);
  });

  it("migrates legacy Telegram pairing allowFrom store to account-scoped default file", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const { oauthDir, detected, result } = await runTelegramAllowFromMigration({ root, cfg });
    expect(detected.channelPlans.hasLegacy).toBe(true);
    expect(detected.channelPlans.plans.map((plan) => path.basename(plan.targetPath))).toEqual([
      "telegram-default-allowFrom.json",
    ]);
    expect(result.warnings).toStrictEqual([]);

    const target = path.join(oauthDir, "telegram-default-allowFrom.json");
    expect(fs.existsSync(target)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
      version: 1,
      allowFrom: ["123456"],
    });
  });

  it("does not fan out legacy Telegram pairing allowFrom store to configured named accounts", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "bot2",
          accounts: {
            bot1: {},
            bot2: {},
          },
        },
      },
    };
    const { oauthDir, detected, result } = await runTelegramAllowFromMigration({ root, cfg });
    expect(detected.channelPlans.hasLegacy).toBe(true);
    expect(detected.channelPlans.plans.map((plan) => path.basename(plan.targetPath))).toEqual([
      "telegram-bot2-allowFrom.json",
    ]);
    expect(result.warnings).toStrictEqual([]);

    const bot1Target = path.join(oauthDir, "telegram-bot1-allowFrom.json");
    const bot2Target = path.join(oauthDir, "telegram-bot2-allowFrom.json");
    const defaultTarget = path.join(oauthDir, "telegram-default-allowFrom.json");
    expect(fs.existsSync(bot1Target)).toBe(false);
    expect(fs.existsSync(bot2Target)).toBe(true);
    expect(fs.existsSync(defaultTarget)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bot2Target, "utf-8"))).toEqual({
      version: 1,
      allowFrom: ["123456"],
    });
  });

  it("migrates legacy Telegram pairing allowFrom store to the default agent bound account", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "ops", default: true }],
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "alerts" } }],
      channels: {
        telegram: {
          accounts: {
            alerts: {},
            backup: {},
          },
        },
      },
    };

    const { oauthDir, detected, result } = await runTelegramAllowFromMigration({ root, cfg });
    expect(detected.channelPlans.hasLegacy).toBe(true);
    expect(detected.channelPlans.plans.map((plan) => path.basename(plan.targetPath))).toEqual([
      "telegram-alerts-allowFrom.json",
    ]);
    expect(result.warnings).toStrictEqual([]);

    const alertsTarget = path.join(oauthDir, "telegram-alerts-allowFrom.json");
    const backupTarget = path.join(oauthDir, "telegram-backup-allowFrom.json");
    const defaultTarget = path.join(oauthDir, "telegram-default-allowFrom.json");
    expect(fs.existsSync(alertsTarget)).toBe(true);
    expect(fs.existsSync(backupTarget)).toBe(false);
    expect(fs.existsSync(defaultTarget)).toBe(false);
    expect(JSON.parse(fs.readFileSync(alertsTarget, "utf-8"))).toEqual({
      version: 1,
      allowFrom: ["123456"],
    });
  });

  it("no-ops when nothing detected", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });
    expect(result.changes).toStrictEqual([]);
  });

  it("imports plugin-state legacy plans through doctor", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "legacy-cache.json");
    const globalSourcePath = path.join(root, "legacy-global-cache.json");
    fs.writeFileSync(sourcePath, "legacy", "utf-8");
    fs.writeFileSync(globalSourcePath, "global", "utf-8");
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test prompt-context cache",
        sourcePath,
        targetPath: "plugin state:test.prompt-cache",
        pluginId: "telegram",
        namespace: "test.prompt-cache",
        maxEntries: 4,
        scopeKey: "scope",
        cleanupSource: "rename",
        readEntries: () => [
          { key: "old", value: { body: "old" } },
          { key: "existing", value: { body: "stale" } },
          { key: "overflow", value: { body: "overflow" } },
        ],
      },
      {
        kind: "plugin-state-import",
        label: "Test global cache",
        sourcePath: globalSourcePath,
        targetPath: "plugin state:test.global-cache",
        pluginId: "telegram",
        namespace: "test.global-cache",
        maxEntries: 4,
        scopeKey: "",
        cleanupSource: "rename",
        readEntries: () => [{ key: "default", value: { body: "global" }, ttlMs: 60_000 }],
      },
    ];

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.prompt-cache",
        maxEntries: 4,
      });
      await store.register("scope:existing", { body: "fresh" });
      await store.register("other:keep", { body: "other" });
    });
    resetPluginStateStoreForTests();

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 2 Test prompt-context cache entries → plugin state");
    expect(result.changes).toContain("Migrated 1 Test global cache entry → plugin state");
    expect(result.changes).toContain(
      `Archived Test prompt-context cache legacy source → ${sourcePath}.migrated`,
    );
    expect(result.changes).toContain(
      `Archived Test global cache legacy source → ${globalSourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(globalSourcePath)).toBe(false);
    expect(fs.existsSync(`${globalSourcePath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.prompt-cache",
        maxEntries: 4,
      });
      const valuesByKey = new Map(
        (await store.entries()).map(({ key, value }) => [key, value.body]),
      );
      expect(Object.fromEntries(valuesByKey)).toEqual({
        "other:keep": "other",
        "scope:existing": "fresh",
        "scope:old": "old",
        "scope:overflow": "overflow",
      });

      const globalStore = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.global-cache",
        maxEntries: 4,
      });
      const globalValuesByKey = new Map(
        (await globalStore.entries()).map(({ key, value }) => [key, value.body]),
      );
      expect(Object.fromEntries(globalValuesByKey)).toEqual({
        default: "global",
      });
      const globalEntries = await globalStore.entries();
      expect(globalEntries[0]?.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  it("removes plugin-state legacy sources through removeSource once covered", async () => {
    const root = await makeTempRoot();
    const removeSource = vi.fn();
    const removeEmptySource = vi.fn();
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test bucket cache",
        sourcePath: "plugin state:test.legacy-buckets",
        targetPath: "plugin state:test.bucket-cache",
        pluginId: "telegram",
        namespace: "test.bucket-cache",
        maxEntries: 4,
        scopeKey: "",
        removeSource,
        readEntries: () => [{ key: "default", value: { body: "bucket" } }],
      },
      {
        kind: "plugin-state-import",
        label: "Test empty bucket cache",
        sourcePath: "plugin state:test.legacy-empty",
        targetPath: "plugin state:test.empty-cache",
        pluginId: "telegram",
        namespace: "test.empty-cache",
        maxEntries: 4,
        scopeKey: "",
        cleanupWhenEmpty: true,
        removeSource: removeEmptySource,
        readEntries: () => [],
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(removeSource).toHaveBeenCalledTimes(1);
    expect(removeEmptySource).toHaveBeenCalledTimes(1);
    expect(result.changes).toContain(
      "Removed Test bucket cache legacy source (plugin state:test.legacy-buckets)",
    );
    expect(result.changes).toContain(
      "Removed Test empty bucket cache legacy source (plugin state:test.legacy-empty)",
    );
  });

  it("replaces existing plugin-state entries when a channel import plan asks for it", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "legacy-cache.json");
    fs.writeFileSync(sourcePath, "legacy", "utf-8");
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test replace cache",
        sourcePath,
        targetPath: "plugin state:test.replace-cache",
        pluginId: "telegram",
        namespace: "test.replace-cache",
        maxEntries: 4,
        scopeKey: "",
        cleanupSource: "rename",
        readEntries: () => [{ key: "existing", value: { offset: 20 } }],
        shouldReplaceExistingEntry: (params: { existingValue: unknown; incomingValue: unknown }) =>
          (params.incomingValue as { offset: number }).offset >
          (params.existingValue as { offset: number }).offset,
      },
    ];

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ offset: number }>("telegram", {
        namespace: "test.replace-cache",
        maxEntries: 4,
      });
      await store.register("existing", { offset: 10 });
    });
    resetPluginStateStoreForTests();

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 Test replace cache entry → plugin state");
    expect(result.changes).toContain(
      `Archived Test replace cache legacy source → ${sourcePath}.migrated`,
    );

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ offset: number }>("telegram", {
        namespace: "test.replace-cache",
        maxEntries: 4,
      });
      expect(await store.lookup("existing")).toStrictEqual({ offset: 20 });
    });
  });

  it("archives empty plugin-state import sources when the channel plan asks for cleanup", async () => {
    const root = await makeTempRoot();
    const sourceDir = path.join(root, "imessage");
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourcePath = path.join(sourceDir, "reply-cache.jsonl");
    fs.writeFileSync(sourcePath, "expired\n", "utf-8");
    if (process.platform !== "win32") {
      fs.chmodSync(sourceDir, 0o755);
      fs.chmodSync(sourcePath, 0o644);
    }
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test expired cache",
        sourcePath,
        targetPath: "plugin state:test.expired-cache",
        pluginId: "telegram",
        namespace: "test.expired-cache",
        maxEntries: 4,
        scopeKey: "",
        cleanupSource: "rename",
        cleanupWhenEmpty: true,
        readEntries: () => [],
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      `Archived Test expired cache legacy source → ${sourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(`${sourcePath}.migrated`).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps plugin-state import sources when reading entries fails", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "legacy-cache.json");
    fs.writeFileSync(sourcePath, "legacy", "utf-8");
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test unreadable cache",
        sourcePath,
        targetPath: "plugin state:test.unreadable-cache",
        pluginId: "telegram",
        namespace: "test.unreadable-cache",
        maxEntries: 4,
        scopeKey: "",
        cleanupSource: "rename",
        cleanupWhenEmpty: true,
        readEntries: () => {
          throw new Error("read failed");
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      "Failed reading Test unreadable cache legacy source: Error: read failed",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
  });

  it("keeps plugin-state import source when plugin cap eviction drops an imported row", async () => {
    const root = await makeTempRoot();
    const maxPluginStateEntries = 40;
    setMaxPluginStateEntriesPerPluginForTests(maxPluginStateEntries);
    const sourcePath = path.join(root, "legacy-cache.json");
    fs.writeFileSync(sourcePath, "legacy", "utf-8");
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test capped cache",
        sourcePath,
        targetPath: "plugin state:test.capped-cache",
        pluginId: "telegram",
        namespace: "test.capped-cache",
        maxEntries: maxPluginStateEntries,
        scopeKey: "scope",
        cleanupSource: "rename",
        readEntries: () => [
          { key: "first", value: { body: "first" } },
          { key: "second", value: { body: "second" } },
        ],
      },
    ];

    await withStateDir(root, async () => {
      seedPluginStateEntriesForTests(
        Array.from({ length: maxPluginStateEntries - 1 }, (_, index) => ({
          pluginId: "telegram",
          namespace: "test.sibling-cache",
          key: `sibling-${index}`,
          value: { body: "sibling" },
        })),
      );
    });
    resetPluginStateStoreForTests();

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([
      "Stopped migrating Test capped cache because plugin state cap evicted scope:first; left legacy source in place",
    ]);
    expect(result.changes).not.toContain("Migrated 2 Test capped cache entries → plugin state");
    expect(result.changes).not.toContain(
      `Archived Test capped cache legacy source → ${sourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.capped-cache",
        maxEntries: maxPluginStateEntries,
      });
      const valuesByKey = new Map(
        (await store.entries()).map(({ key, value }) => [key, value.body]),
      );
      expect(valuesByKey.has("scope:first")).toBe(false);
      expect(valuesByKey.has("scope:second")).toBe(false);
    });
  });

  it("imports the shipped plugin-state SQLite sidecar into shared state", async () => {
    const root = await makeTempRoot();
    const sourcePath = writeLegacyPluginStateSidecar(root);

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.pluginStateSidecar).toEqual({ sourcePath, hasLegacy: true });
    expect(detected.preview).toContain(
      `- Plugin state sidecar: ${sourcePath} → shared SQLite state`,
    );

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 plugin-state sidecar entry → shared SQLite state");
    expect(result.changes).toContain(
      `Archived plugin-state sidecar legacy source → ${sourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ ok: boolean }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      await expect(store.lookup("interaction:1")).resolves.toEqual({ ok: true });
    });
  });

  it("imports the shipped debug proxy capture sidecar into shared state", async () => {
    const root = await makeTempRoot();
    const { sourcePath, blobDir, blobId } = writeLegacyDebugProxyCaptureSidecar(root);
    const certDir = path.join(root, "debug-proxy", "certs");
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, "ca.pem"), "keep");

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.debugProxyCaptureSidecar).toEqual({
      sourcePath,
      blobDir,
      hasLegacy: true,
    });
    expect(detected.preview).toContain(
      `- Debug proxy capture sidecar: ${sourcePath} → shared SQLite state`,
    );

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated 1 debug proxy capture session, 1 event, and 1 blob → shared SQLite state",
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(blobDir)).toBe(false);
    expect(fs.existsSync(`${blobDir}.migrated`)).toBe(true);
    expect(fs.readFileSync(path.join(certDir, "ca.pem"), "utf8")).toBe("keep");

    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(
      state.db.prepare("SELECT id, mode FROM capture_sessions WHERE id = ?").get("legacy-session"),
    ).toEqual({ id: "legacy-session", mode: "proxy-run" });
    expect(
      state.db
        .prepare("SELECT flow_id, data_blob_id FROM capture_events WHERE session_id = ?")
        .get("legacy-session"),
    ).toEqual({ flow_id: "legacy-flow", data_blob_id: blobId });
    const blob = state.db
      .prepare("SELECT data FROM capture_blobs WHERE blob_id = ?")
      .get(blobId) as { data?: Uint8Array } | undefined;
    expect(gunzipSync(Buffer.from(blob?.data ?? [])).toString("utf8")).toBe('{"legacy":true}');
  });

  it("imports debug proxy capture storage from shipped environment overrides", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "custom-capture", "capture.sqlite");
    const blobDir = path.join(root, "custom-capture", "blobs");
    writeLegacyDebugProxyCaptureSidecar(root, { sourcePath, blobDir });
    const sqlite = requireNodeSqlite();
    const legacyDb = new sqlite.DatabaseSync(sourcePath);
    try {
      legacyDb
        .prepare("UPDATE capture_sessions SET blob_dir = ?")
        .run(path.join(root, "stale-machine-specific-blobs"));
    } finally {
      legacyDb.close();
    }
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_DEBUG_PROXY_DB_PATH: sourcePath,
      OPENCLAW_DEBUG_PROXY_BLOB_DIR: blobDir,
    } as NodeJS.ProcessEnv;

    const detected = await detectLegacyStateMigrations({ cfg: {}, env });
    expect(detected.debugProxyCaptureSidecar).toEqual({
      sourcePath,
      blobDir,
      hasLegacy: true,
    });

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(`${blobDir}.migrated`)).toBe(true);
  });

  it("uses stored per-session debug proxy blob directories without active overrides", async () => {
    const root = await makeTempRoot();
    const blobDir = path.join(root, "custom-session-blobs");
    const { sourcePath, blobId } = writeLegacyDebugProxyCaptureSidecar(root, { blobDir });
    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([
      `Left migrated debug proxy capture blobs in stored session directory: ${blobDir}`,
    ]);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(blobDir)).toBe(true);
    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(
      state.db.prepare("SELECT blob_id FROM capture_blobs WHERE blob_id = ?").get(blobId),
    ).toEqual({ blob_id: blobId });
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({
      count: 1,
    });
  });

  it("ignores a legacy debug proxy override that points at shared state", async () => {
    const root = await makeTempRoot();
    const sharedStatePath = path.join(root, "state", "openclaw.sqlite");
    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    state.db
      .prepare(
        `INSERT INTO capture_sessions (
          id, started_at, mode, source_scope, source_process
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("shared-session", 100, "proxy-run", "openclaw", "openclaw");
    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_DEBUG_PROXY_DB_PATH: sharedStatePath,
      } as NodeJS.ProcessEnv,
    });

    expect(detected.debugProxyCaptureSidecar).toEqual({
      sourcePath: sharedStatePath,
      blobDir: path.join(root, "debug-proxy", "blobs"),
      hasLegacy: false,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(sharedStatePath)).toBe(true);
    expect(fs.existsSync(`${sharedStatePath}.migrated`)).toBe(false);
    expect(
      state.db.prepare("SELECT id FROM capture_sessions WHERE id = ?").get("shared-session"),
    ).toEqual({ id: "shared-session" });
  });

  it("preserves duplicate debug proxy events and retry idempotency", async () => {
    const root = await makeTempRoot();
    const { sourcePath } = writeLegacyDebugProxyCaptureSidecar(root);
    const sqlite = requireNodeSqlite();
    const legacyDb = new sqlite.DatabaseSync(sourcePath);
    try {
      legacyDb.exec(`
        INSERT INTO capture_events (
          session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
          method, host, path, status, close_code, content_type, headers_json, data_text,
          data_blob_id, data_sha256, error_text, meta_json
        )
        SELECT
          session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
          method, host, path, status, close_code, content_type, headers_json, data_text,
          data_blob_id, data_sha256, error_text, meta_json
        FROM capture_events
        LIMIT 1;
      `);
    } finally {
      legacyDb.close();
    }
    const rename = failRenameOnce(sourcePath);
    const firstResult = await (async () => {
      try {
        return await runLegacyStateMigrationsForRoot(root);
      } finally {
        rename.mockRestore();
      }
    })();

    expect(firstResult.warnings).toStrictEqual([
      `Failed archiving debug proxy capture sidecar ${sourcePath}: Error: forced archive failure`,
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    const retryResult = await runLegacyStateMigrationsForRoot(root);

    expect(retryResult.warnings).toStrictEqual([]);
    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({
      count: 2,
    });
  });

  it("leaves debug proxy sources in place when a session id conflicts", async () => {
    const root = await makeTempRoot();
    const { sourcePath, blobDir } = writeLegacyDebugProxyCaptureSidecar(root);
    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    state.db
      .prepare(
        `INSERT INTO capture_sessions (
          id, started_at, mode, source_scope, source_process
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy-session", 999, "different", "openclaw", "openclaw");

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([
      `Failed migrating debug proxy capture sidecar ${sourcePath}: session legacy-session already exists with different data`,
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(blobDir)).toBe(true);
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({
      count: 0,
    });
  });

  it("retries debug proxy blob archival without duplicating imported events", async () => {
    const root = await makeTempRoot();
    const { sourcePath, blobDir } = writeLegacyDebugProxyCaptureSidecar(root);
    const rename = failRenameOnce(blobDir);
    const firstResult = await (async () => {
      try {
        return await runLegacyStateMigrationsForRoot(root);
      } finally {
        rename.mockRestore();
      }
    })();

    expect(firstResult.warnings).toStrictEqual([
      `Failed archiving debug proxy capture blobs ${blobDir}: Error: forced archive failure`,
    ]);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(blobDir)).toBe(true);

    const retryDetected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(retryDetected.debugProxyCaptureSidecar.hasLegacy).toBe(true);
    const retryResult = await runLegacyStateMigrations({ detected: retryDetected });

    expect(retryResult.warnings).toStrictEqual([]);
    expect(retryResult.changes).toStrictEqual([
      `Archived debug proxy capture blobs → ${blobDir}.migrated`,
    ]);
    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({
      count: 1,
    });
  });

  it("archives the plugin-state rollback journal with the legacy database", async () => {
    const root = await makeTempRoot();
    const sourcePath = writeLegacyPluginStateSidecar(root);
    const journalPath = `${sourcePath}-journal`;
    fs.writeFileSync(journalPath, "");

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.existsSync(`${journalPath}.migrated`)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
  });

  it("retries plugin-state archival after a sidecar rename failure", async () => {
    const root = await makeTempRoot();
    const sourcePath = writeLegacyPluginStateSidecar(root);
    const walPath = `${sourcePath}-wal`;
    const pendingWalState = writePendingWalSnapshot(sourcePath, (db) => {
      db.prepare(`
        UPDATE plugin_state_entries
        SET value_json = ?
        WHERE plugin_id = ? AND namespace = ? AND entry_key = ?
      `).run('{"ok":"from-wal"}', "discord", "components", "interaction:1");
    });

    const rename = failRenameOnce(walPath);
    const firstResult = await (async () => {
      try {
        return await runLegacyStateMigrationsForRoot(root);
      } finally {
        rename.mockRestore();
      }
    })();

    expect(firstResult.changes).toContain(
      "Migrated 1 plugin-state sidecar entry → shared SQLite state",
    );
    expect(firstResult.warnings).toStrictEqual([
      `Failed archiving plugin-state sidecar ${walPath}: Error: forced archive failure`,
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(walPath)).toBe(true);
    expect(fs.existsSync(`${walPath}.migrated`)).toBe(false);

    const retryDetected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(retryDetected.pluginStateSidecar).toEqual({ sourcePath, hasLegacy: true });
    expect(retryDetected.preview).toContain(
      `- Plugin state sidecar: finish archive cleanup for ${sourcePath}`,
    );
    const retryResult = await runLegacyStateMigrations({ detected: retryDetected });

    expect(retryResult.warnings).toStrictEqual([]);
    expect(retryResult.changes).toStrictEqual([
      `Archived plugin-state sidecar legacy source → ${sourcePath}.migrated`,
    ]);
    expect(fs.existsSync(walPath)).toBe(false);
    expect(fs.readFileSync(`${walPath}.migrated`)).toEqual(pendingWalState);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ ok: string }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      await expect(store.lookup("interaction:1")).resolves.toEqual({ ok: "from-wal" });
    });
  });

  it("imports the legacy plugin install index JSON into shared state", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "plugins", "installs.json");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        plugins: [
          {
            pluginId: "demo",
            installRecord: {
              source: "npm",
              spec: "demo@1.0.0",
            },
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.pluginInstallIndex).toEqual({ sourcePath, hasLegacy: true });
    expect(detected.preview).toContain(
      `- Plugin install index: ${sourcePath} → shared SQLite state`,
    );

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated plugin install index 1 record → shared SQLite state",
    );
    expect(result.changes).toContain(
      `Archived plugin install index legacy source → ${sourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
      installRecords: { demo: { source: "npm", spec: "demo@1.0.0" } },
      plugins: [],
    });
  });

  it("imports legacy record-only plugin install index JSON into shared state", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "plugins", "installs.json");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        installRecords: {
          demo: {
            source: "npm",
            spec: "demo@1.0.0",
          },
        },
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated plugin install index 1 record → shared SQLite state",
    );
    await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
      installRecords: { demo: { source: "npm", spec: "demo@1.0.0" } },
      plugins: [],
    });
  });

  it("imports legacy records-only plugin install index JSON into shared state", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "plugins", "installs.json");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        records: {
          demo: {
            source: "path",
            sourcePath: "/tmp/demo",
          },
        },
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated plugin install index 1 record → shared SQLite state",
    );
    await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
      installRecords: { demo: { source: "path", sourcePath: "/tmp/demo" } },
      plugins: [],
    });
  });

  it("merges missing legacy plugin install records into an existing SQLite index", async () => {
    const root = await makeTempRoot();
    await writeExistingPluginInstallIndex(root, {
      existing: {
        source: "npm",
        spec: "existing@1.0.0",
      },
    });
    const sourcePath = writeLegacyPluginInstallIndex(root, {
      legacy: {
        source: "git",
        spec: "git:file:///tmp/legacy",
      },
    });

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Merged 1 legacy plugin install record → shared SQLite state");
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
      installRecords: {
        existing: { source: "npm", spec: "existing@1.0.0" },
        legacy: { source: "git", spec: "git:file:///tmp/legacy" },
      },
    });
  });

  it("archives legacy plugin install index when SQLite already has richer matching records", async () => {
    const root = await makeTempRoot();
    await writeExistingPluginInstallIndex(root, {
      demo: {
        source: "npm",
        spec: "demo@latest",
        version: "1.0.0",
        resolvedName: "demo",
        resolvedVersion: "1.0.0",
        resolvedSpec: "demo@1.0.0",
        integrity: "sha512-current",
        shasum: "current",
        installedAt: "2026-06-01T21:04:35.000Z",
      },
    });
    const sourcePath = writeLegacyPluginInstallIndex(root, {
      demo: {
        source: "npm",
        spec: "demo@1.0.0",
        version: "1.0.0",
      },
    });

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
      installRecords: {
        demo: {
          source: "npm",
          spec: "demo@latest",
          resolvedVersion: "1.0.0",
          integrity: "sha512-current",
        },
      },
    });
  });

  it("archives exact legacy npm install record when SQLite has authoritative resolved metadata", async () => {
    const root = await makeTempRoot();
    await writeExistingPluginInstallIndex(root, {
      discord: {
        source: "npm",
        spec: "@openclaw/discord@latest",
        resolvedName: "@openclaw/discord",
        resolvedVersion: "2026.6.16",
        integrity: "sha512-current",
        installedAt: "2026-06-16T12:00:00.000Z",
      },
    });
    const sourcePath = writeLegacyPluginInstallIndex(root, {
      discord: {
        source: "npm",
        spec: "@openclaw/discord@2026.6.16",
        version: "2026.6.16",
        installedAt: "2026-06-01T12:00:00.000Z",
      },
    });

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
      installRecords: {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@latest",
          resolvedName: "@openclaw/discord",
          resolvedVersion: "2026.6.16",
          integrity: "sha512-current",
        },
      },
    });
  });

  it("keeps exact legacy npm install record when SQLite lacks authoritative package identity", async () => {
    const root = await makeTempRoot();
    await writeExistingPluginInstallIndex(root, {
      demo: {
        source: "npm",
        spec: "demo@latest",
        version: "1.0.0",
      },
    });
    const sourcePath = writeLegacyPluginInstallIndex(root, {
      demo: {
        source: "npm",
        spec: "demo@1.0.0",
        version: "1.0.0",
      },
    });

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([
      "Left plugin install index in place because shared SQLite state has conflicting plugin install metadata for: demo",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
  });

  for (const fixture of [
    {
      label: "name different packages",
      current: {
        source: "npm",
        spec: "@openclaw/demo@1.0.0",
        version: "1.0.0",
        resolvedName: "@openclaw/demo",
        resolvedVersion: "1.0.0",
        resolvedSpec: "@openclaw/demo@1.0.0",
      },
      legacy: {
        source: "npm",
        spec: "@vendor/demo@1.0.0",
        version: "1.0.0",
      },
    },
    {
      label: "specs are unparseable",
      current: {
        source: "npm",
        spec: "file:../current-demo",
        version: "1.0.0",
        resolvedVersion: "1.0.0",
      },
      legacy: {
        source: "npm",
        spec: "file:../legacy-demo",
        version: "1.0.0",
      },
    },
    {
      label: "would pin a legacy floating selector to an exact version",
      current: {
        source: "npm",
        spec: "demo@1.0.0",
        version: "1.0.0",
        resolvedName: "demo",
        resolvedVersion: "1.0.0",
        resolvedSpec: "demo@1.0.0",
      },
      legacy: {
        source: "npm",
        spec: "demo@beta",
        version: "1.0.0",
      },
    },
    {
      label: "use different floating selectors",
      current: {
        source: "npm",
        spec: "demo@latest",
        version: "1.0.0",
        resolvedName: "demo",
        resolvedVersion: "1.0.0",
        resolvedSpec: "demo@1.0.0",
      },
      legacy: {
        source: "npm",
        spec: "demo@beta",
        version: "1.0.0",
      },
    },
    {
      label: "keep legacy floating selectors even when resolved specs match",
      current: {
        source: "npm",
        spec: "demo@latest",
        version: "1.0.0",
        resolvedName: "demo",
        resolvedVersion: "1.0.0",
        resolvedSpec: "demo@1.0.0",
      },
      legacy: {
        source: "npm",
        spec: "demo@beta",
        version: "1.0.0",
        resolvedName: "demo",
        resolvedVersion: "1.0.0",
        resolvedSpec: "demo@1.0.0",
      },
    },
    {
      label: "have malformed legacy spec metadata",
      current: {
        source: "npm",
        spec: "demo@1.0.0",
        version: "1.0.0",
        resolvedName: "demo",
        resolvedVersion: "1.0.0",
        resolvedSpec: "demo@1.0.0",
      },
      legacy: {
        source: "npm",
        spec: { raw: "demo@beta" },
        version: "1.0.0",
      } as unknown as InstalledPluginInstallRecordInfo,
    },
  ] satisfies Array<{
    label: string;
    current: InstalledPluginInstallRecordInfo;
    legacy: InstalledPluginInstallRecordInfo;
  }>) {
    it(`keeps legacy plugin install index when same-version npm records ${fixture.label}`, async () => {
      const root = await makeTempRoot();
      await writeExistingPluginInstallIndex(root, { demo: fixture.current });
      const sourcePath = writeLegacyPluginInstallIndex(root, { demo: fixture.legacy });

      const result = await runLegacyStateMigrationsForRoot(root);

      expect(result.warnings).toStrictEqual([
        "Left plugin install index in place because shared SQLite state has conflicting plugin install metadata for: demo",
      ]);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
    });
  }

  it("auto-migrates the shipped plugin-state SQLite sidecar by itself", async () => {
    const root = await makeTempRoot();
    const sourcePath = writeLegacyPluginStateSidecar(root);

    const result = await autoMigrateLegacyState({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.skipped).toBe(false);
    expect(result.changes).toContain("Migrated 1 plugin-state sidecar entry → shared SQLite state");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ ok: boolean }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      await expect(store.lookup("interaction:1")).resolves.toEqual({ ok: true });
    });
  });

  it("auto-migrates the plugin-state sidecar when custom agent dirs skip session migration", async () => {
    const root = await makeTempRoot();
    const sourcePath = writeLegacyPluginStateSidecar(root);

    const result = await autoMigrateLegacyState({
      cfg: {},
      env: {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_AGENT_DIR: path.join(root, "custom-agent"),
      } as NodeJS.ProcessEnv,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.skipped).toBe(true);
    expect(result.changes).toContain("Migrated 1 plugin-state sidecar entry → shared SQLite state");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ ok: boolean }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      await expect(store.lookup("interaction:1")).resolves.toEqual({ ok: true });
    });
  });

  it("migrates default exec approvals into an explicit state dir", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "custom-state");
    const sourcePath = path.join(root, ".openclaw", "exec-approvals.json");
    const legacySocketPath = path.join(root, ".openclaw", "exec-approvals.sock");
    const targetPath = path.join(stateDir, "exec-approvals.json");
    const targetSocketPath = path.join(stateDir, "exec-approvals.sock");
    writeJson5(sourcePath, {
      version: 1,
      socket: {
        path: legacySocketPath,
        token: "legacy-token",
      },
      defaults: {
        security: "deny",
        ask: "always",
      },
      agents: {
        main: {
          allowlist: [{ pattern: "git status" }],
        },
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      homedir: () => root,
      crossStateDirImports: true,
    });
    expect(detected.preview).toContain(`- Exec approvals: ${sourcePath} → ${targetPath}`);

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(`Migrated exec approvals → ${targetPath}`);
    expect(result.changes).toContain(`Archived legacy exec approvals → ${sourcePath}.migrated`);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    const migrated = JSON.parse(fs.readFileSync(targetPath, "utf8")) as {
      socket?: { path?: string; token?: string };
      defaults?: Record<string, unknown>;
      agents?: Record<string, { allowlist?: Array<Record<string, unknown>> }>;
    };
    expect(migrated.socket?.path).toBe(targetSocketPath);
    expect(migrated.socket?.token).toBe("legacy-token");
    expect(migrated.defaults).toEqual({
      security: "deny",
      ask: "always",
    });
    expect(migrated.agents?.main?.allowlist?.[0]?.pattern).toBe("git status");
  });

  it("skips exec approvals migration when the target appears after detection", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "custom-state");
    const sourcePath = path.join(root, ".openclaw", "exec-approvals.json");
    const targetPath = path.join(stateDir, "exec-approvals.json");
    writeJson5(sourcePath, {
      version: 1,
      socket: {
        token: "legacy-token",
      },
      defaults: {
        security: "deny",
      },
    });
    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      homedir: () => root,
      crossStateDirImports: true,
    });
    writeJson5(targetPath, {
      version: 1,
      socket: {
        path: path.join(stateDir, "exec-approvals.sock"),
        token: "current-token",
      },
      defaults: {
        security: "full",
        ask: "off",
      },
    });

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).not.toContain(`Migrated exec approvals → ${targetPath}`);
    const current = JSON.parse(fs.readFileSync(targetPath, "utf8")) as {
      socket?: { token?: string };
      defaults?: Record<string, unknown>;
    };
    expect(current.socket?.token).toBe("current-token");
    expect(current.defaults).toEqual({
      security: "full",
      ask: "off",
    });
  });

  it("auto-migrates exec approvals without a valid config snapshot when doctor opts in", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "custom-state");
    const sourcePath = path.join(root, ".openclaw", "exec-approvals.json");
    const targetPath = path.join(stateDir, "exec-approvals.json");
    writeJson5(sourcePath, {
      version: 1,
      socket: {
        token: "legacy-token",
      },
      defaults: {
        security: "deny",
        ask: "always",
      },
    });

    const result = await autoMigrateLegacyTaskStateSidecars({
      env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      homedir: () => root,
      crossStateDirImports: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(`Migrated exec approvals → ${targetPath}`);
    expect(result.changes).toContain(`Archived legacy exec approvals → ${sourcePath}.migrated`);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    const migrated = JSON.parse(fs.readFileSync(targetPath, "utf8")) as {
      socket?: { token?: string };
      defaults?: Record<string, unknown>;
    };
    expect(migrated.socket?.token).toBe("legacy-token");
    expect(migrated.defaults).toEqual({
      security: "deny",
      ask: "always",
    });
  });

  it("keeps default exec approvals in place without the cross-state-dir opt-in", async () => {
    // Regression: the implicit preflight (every CLI command, gateway startup)
    // must never archive files that belong to the default state dir just
    // because OPENCLAW_STATE_DIR points somewhere else.
    const root = await makeTempRoot();
    const stateDir = path.join(root, "custom-state");
    const sourcePath = path.join(root, ".openclaw", "exec-approvals.json");
    const targetPath = path.join(stateDir, "exec-approvals.json");
    writeJson5(sourcePath, {
      version: 1,
      socket: {
        token: "legacy-token",
      },
      defaults: {
        security: "deny",
        ask: "always",
      },
    });
    const sourceRaw = fs.readFileSync(sourcePath, "utf8");

    const result = await autoMigrateLegacyTaskStateSidecars({
      env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      homedir: () => root,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).not.toContain(`Migrated exec approvals → ${targetPath}`);
    expect(result.notices?.join("\n")).toContain(
      "Exec approvals in the default state dir were not imported",
    );
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceRaw);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("keeps default exec approvals in place when autoMigrateLegacyState runs without the opt-in", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "custom-state");
    const sourcePath = path.join(root, ".openclaw", "exec-approvals.json");
    const targetPath = path.join(stateDir, "exec-approvals.json");
    writeJson5(sourcePath, {
      version: 1,
      socket: {
        token: "legacy-token",
      },
      defaults: {
        security: "deny",
      },
    });
    const sourceRaw = fs.readFileSync(sourcePath, "utf8");

    const result = await autoMigrateLegacyState({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      homedir: () => root,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).not.toContain(`Migrated exec approvals → ${targetPath}`);
    expect(result.notices?.join("\n")).toContain(
      "Exec approvals in the default state dir were not imported",
    );
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceRaw);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("keeps the plugin-state sidecar when shared state already has a conflicting row", async () => {
    const root = await makeTempRoot();
    const sourcePath = writeLegacyPluginStateSidecar(root);
    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ ok: boolean }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      await store.register("interaction:1", { ok: false });
    });
    resetPluginStateStoreForTests();

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([
      "Left plugin-state sidecar in place because 1 row already existed in shared state: discord/components/interaction:1",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ ok: boolean }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      await expect(store.lookup("interaction:1")).resolves.toEqual({ ok: false });
    });
  });

  it("imports legacy-only plugin-state rows and archives when remaining conflicts are expired", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "plugin-state", "state.sqlite");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(sourcePath);
    try {
      db.exec(`
        CREATE TABLE plugin_state_entries (
          plugin_id TEXT NOT NULL,
          namespace TEXT NOT NULL,
          entry_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (plugin_id, namespace, entry_key)
        );
      `);
      const insert = db.prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        "telegram",
        "telegram.bot-info-cache",
        "default",
        '{"fetchedAt":"2026-05-30T23:20:09.000Z"}',
        1000,
        1,
      );
      insert.run("telegram", "message-cache", "legacy-only", '{"ok":true}', 2000, null);
    } finally {
      db.close();
    }
    await withStateDir(root, async () => {
      seedPluginStateEntriesForTests([
        {
          pluginId: "telegram",
          namespace: "telegram.bot-info-cache",
          key: "default",
          value: { fetchedAt: "2026-06-01T21:04:35.000Z" },
          createdAt: 3000,
          expiresAt: Date.now() + 60_000,
        },
      ]);
    });
    resetPluginStateStoreForTests();

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 plugin-state sidecar entry → shared SQLite state");
    expect(result.changes).toContain("Dropped 1 expired plugin-state sidecar entry");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const botInfoStore = createPluginStateKeyedStore<{ fetchedAt: string }>("telegram", {
        namespace: "telegram.bot-info-cache",
        maxEntries: 10,
      });
      await expect(botInfoStore.lookup("default")).resolves.toEqual({
        fetchedAt: "2026-06-01T21:04:35.000Z",
      });
      const messageStore = createPluginStateKeyedStore<{ ok: boolean }>("telegram", {
        namespace: "message-cache",
        maxEntries: 10,
      });
      await expect(messageStore.lookup("legacy-only")).resolves.toEqual({ ok: true });
    });
  });

  it("does not report expired plugin-state sidecar rows as dropped when live conflicts keep the sidecar", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "plugin-state", "state.sqlite");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(sourcePath);
    try {
      db.exec(`
        CREATE TABLE plugin_state_entries (
          plugin_id TEXT NOT NULL,
          namespace TEXT NOT NULL,
          entry_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (plugin_id, namespace, entry_key)
        );
      `);
      const insert = db.prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      insert.run("telegram", "telegram.bot-info-cache", "default", '{"stale":true}', 1000, 1);
      insert.run("discord", "components", "interaction:1", '{"ok":true}', 1000, null);
    } finally {
      db.close();
    }
    await withStateDir(root, async () => {
      seedPluginStateEntriesForTests([
        {
          pluginId: "telegram",
          namespace: "telegram.bot-info-cache",
          key: "default",
          value: { stale: false },
          createdAt: 3000,
          expiresAt: Date.now() + 60_000,
        },
        {
          pluginId: "discord",
          namespace: "components",
          key: "interaction:1",
          value: { ok: false },
          createdAt: 3000,
          expiresAt: null,
        },
      ]);
    });
    resetPluginStateStoreForTests();

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      "Left plugin-state sidecar in place because 1 row already existed in shared state: discord/components/interaction:1",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
  });

  it("archives the plugin-state sidecar when conflicting rows already match", async () => {
    const root = await makeTempRoot();
    const sourcePath = writeLegacyPluginStateSidecar(root);
    await withStateDir(root, async () => {
      seedPluginStateEntriesForTests([
        {
          pluginId: "discord",
          namespace: "components",
          key: "interaction:1",
          value: { ok: true },
          createdAt: 1000,
          expiresAt: null,
        },
      ]);
    });
    resetPluginStateStoreForTests();

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
  });

  it("lets live sidecar rows replace expired shared plugin state during migration", async () => {
    const root = await makeTempRoot();
    const sourcePath = writeLegacyPluginStateSidecar(root);
    await withStateDir(root, async () => {
      seedPluginStateEntriesForTests([
        {
          pluginId: "discord",
          namespace: "components",
          key: "interaction:1",
          value: { ok: false },
          expiresAt: 1,
        },
      ]);
    });
    resetPluginStateStoreForTests();

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ ok: boolean }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      await expect(store.lookup("interaction:1")).resolves.toEqual({ ok: true });
    });
  });

  it("imports shipped task registry and flow SQLite sidecars into shared state", async () => {
    const root = await makeTempRoot();
    const { taskRunsPath, flowRunsPath } = writeLegacyTaskStateSidecars(root);

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(detected.taskStateSidecars).toEqual({
      taskRunsPath,
      flowRunsPath,
      hasLegacy: true,
    });
    expect(detected.preview).toContain(
      `- Task registry sidecar: ${taskRunsPath} → shared SQLite state`,
    );
    expect(detected.preview).toContain(
      `- Task flow sidecar: ${flowRunsPath} → shared SQLite state`,
    );

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 task registry sidecar row → shared SQLite state");
    expect(result.changes).toContain("Migrated 1 task delivery sidecar row → shared SQLite state");
    expect(result.changes).toContain("Migrated 1 task flow sidecar row → shared SQLite state");
    expect(fs.existsSync(taskRunsPath)).toBe(false);
    expect(fs.existsSync(`${taskRunsPath}.migrated`)).toBe(true);
    expect(fs.existsSync(flowRunsPath)).toBe(false);
    expect(fs.existsSync(`${flowRunsPath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const taskState = loadTaskRegistryStateFromSqlite();
      const task = taskState.tasks.get("legacy-task");
      expect(task).toMatchObject({
        taskId: "legacy-task",
        ownerKey: "system:cron:nightly",
        scopeKind: "system",
        requesterSessionKey: "",
        agentId: "ops",
        runId: "legacy-task-run",
      });
      expect(taskState.deliveryStates.get("legacy-task")).toMatchObject({
        taskId: "legacy-task",
        lastNotifiedEventAt: 120,
      });

      const flowState = loadTaskFlowRegistryStateFromSqlite();
      expect(flowState.flows.get("legacy-flow")).toMatchObject({
        flowId: "legacy-flow",
        ownerKey: "agent:main:legacy-flow",
        syncMode: "managed",
        controllerId: "core/legacy-restored",
        revision: 0,
      });
    });
  });

  it("archives task rollback journals with the legacy databases", async () => {
    const root = await makeTempRoot();
    const { taskRunsPath, flowRunsPath } = writeLegacyTaskStateSidecars(root);
    const taskJournalPath = `${taskRunsPath}-journal`;
    const flowJournalPath = `${flowRunsPath}-journal`;
    fs.writeFileSync(taskJournalPath, "");
    fs.writeFileSync(flowJournalPath, "");

    const result = await autoMigrateLegacyTaskStateSidecars({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(result.warnings).toStrictEqual([]);
    for (const sourcePath of [taskRunsPath, flowRunsPath]) {
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
      expect(fs.existsSync(`${sourcePath}-journal`)).toBe(false);
      expect(fs.existsSync(`${sourcePath}-journal.migrated`)).toBe(true);
    }
  });

  it("reports pending task and flow sidecar archive cleanup", async () => {
    const root = await makeTempRoot();
    const taskRunsPath = path.join(root, "tasks", "runs.sqlite");
    const flowRunsPath = path.join(root, "flows", "registry.sqlite");
    for (const sourcePath of [taskRunsPath, flowRunsPath]) {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(`${sourcePath}.migrated`, "");
      fs.writeFileSync(`${sourcePath}-wal`, "");
    }

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(detected.taskStateSidecars.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      `- Task registry sidecar: finish archive cleanup for ${taskRunsPath}`,
    );
    expect(detected.preview).toContain(
      `- Task flow sidecar: finish archive cleanup for ${flowRunsPath}`,
    );
  });

  it("retries task-state archival after a sidecar rename failure", async () => {
    const root = await makeTempRoot();
    const { taskRunsPath } = writeLegacyTaskStateSidecars(root);
    const walPath = `${taskRunsPath}-wal`;
    const pendingWalState = writePendingWalSnapshot(taskRunsPath, (db) => {
      db.prepare("UPDATE task_runs SET label = ? WHERE task_id = ?").run(
        "Pending WAL task",
        "legacy-task",
      );
    });

    const rename = failRenameOnce(walPath);
    const firstResult = await (async () => {
      try {
        return await autoMigrateLegacyTaskStateSidecars({
          env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
        });
      } finally {
        rename.mockRestore();
      }
    })();

    expect(firstResult.changes).toContain(
      "Migrated 1 task registry sidecar row → shared SQLite state",
    );
    expect(firstResult.warnings).toStrictEqual([
      `Failed archiving task registry sidecar ${walPath}: Error: forced archive failure`,
    ]);
    expect(fs.existsSync(taskRunsPath)).toBe(false);
    expect(fs.existsSync(`${taskRunsPath}.migrated`)).toBe(true);
    expect(fs.existsSync(walPath)).toBe(true);
    expect(fs.existsSync(`${walPath}.migrated`)).toBe(false);

    resetAutoMigrateLegacyTaskStateSidecarsForTest();
    const retryResult = await autoMigrateLegacyTaskStateSidecars({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(retryResult.warnings).toStrictEqual([]);
    expect(retryResult.changes).toStrictEqual([
      `Archived task registry sidecar legacy source → ${taskRunsPath}.migrated`,
    ]);
    expect(fs.existsSync(walPath)).toBe(false);
    expect(fs.readFileSync(`${walPath}.migrated`)).toEqual(pendingWalState);

    await withStateDir(root, async () => {
      expect(loadTaskRegistryStateFromSqlite().tasks.get("legacy-task")).toMatchObject({
        label: "Pending WAL task",
      });
    });
  });

  it("skips orphan task delivery sidecar rows while importing valid task rows", async () => {
    const root = await makeTempRoot();
    const { taskRunsPath } = writeLegacyTaskStateSidecars(root);
    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(taskRunsPath);
    try {
      db.prepare(
        `
          INSERT INTO task_delivery_state (
            task_id, requester_origin_json, last_notified_event_at
          ) VALUES (?, ?, ?)
        `,
      ).run("missing-task", '{"channel":"stale","to":"target"}', 130);
    } finally {
      db.close();
    }

    const result = await autoMigrateLegacyTaskStateSidecars({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(result.changes).toContain("Migrated 1 task registry sidecar row → shared SQLite state");
    expect(result.changes).toContain("Migrated 1 task delivery sidecar row → shared SQLite state");
    expect(result.warnings).toContain(
      "Skipped 1 orphan task delivery sidecar row with no task run",
    );
    expect(fs.existsSync(`${taskRunsPath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const taskState = loadTaskRegistryStateFromSqlite();
      expect(taskState.tasks.has("legacy-task")).toBe(true);
      expect(taskState.deliveryStates.has("legacy-task")).toBe(true);
      expect(taskState.deliveryStates.has("missing-task")).toBe(false);
    });
  });

  it("auto-migrates task sidecars without config-dependent state moves", async () => {
    const root = await makeTempRoot();
    const { taskRunsPath, flowRunsPath } = writeLegacyTaskStateSidecars(root);

    const result = await autoMigrateLegacyTaskStateSidecars({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 task registry sidecar row → shared SQLite state");
    expect(result.changes).toContain("Migrated 1 task flow sidecar row → shared SQLite state");
    expect(fs.existsSync(`${taskRunsPath}.migrated`)).toBe(true);
    expect(fs.existsSync(`${flowRunsPath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      expect(loadTaskRegistryStateFromSqlite().tasks.has("legacy-task")).toBe(true);
      expect(loadTaskFlowRegistryStateFromSqlite().flows.has("legacy-flow")).toBe(true);
    });
  });

  it("normalizes obsolete task delivery status before archiving the legacy sidecar", async () => {
    const root = await makeTempRoot();
    const { taskRunsPath } = writeLegacyTaskStateSidecars(root);
    appendLegacyTaskWithObsoleteDeliveryStatus(taskRunsPath);

    const result = await autoMigrateLegacyTaskStateSidecars({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 2 task registry sidecar rows → shared SQLite state");
    expect(fs.existsSync(taskRunsPath)).toBe(false);
    expect(fs.existsSync(`${taskRunsPath}.migrated`)).toBe(true);

    const shared = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(
      shared.db
        .prepare("SELECT delivery_status FROM task_runs WHERE task_id = ?")
        .get("legacy-not-requested"),
    ).toEqual({ delivery_status: "not_applicable" });

    await withStateDir(root, async () => {
      const tasks = loadTaskRegistryStateFromSqlite().tasks;
      expect(tasks.get("legacy-not-requested")?.deliveryStatus).toBe("not_applicable");
      expect(tasks.get("legacy-task")?.deliveryStatus).toBe("not_applicable");
    });
  });

  it("canonicalizes cross-agent attribution while importing task sidecars", async () => {
    const root = await makeTempRoot();
    const { taskRunsPath } = writeLegacyTaskStateSidecars(root);
    appendLegacyCrossAgentTask(taskRunsPath);

    const result = await autoMigrateLegacyTaskStateSidecars({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 2 task registry sidecar rows → shared SQLite state");

    await withStateDir(root, async () => {
      expect(loadTaskRegistryStateFromSqlite().tasks.get("legacy-cross-agent")).toMatchObject({
        taskId: "legacy-cross-agent",
        agentId: "worker",
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:worker:subagent:child",
      });
    });
  });

  it("keeps task sidecars when only requester attribution conflicts", async () => {
    const root = await makeTempRoot();
    const { taskRunsPath } = writeLegacyTaskStateSidecars(root);
    appendLegacyCrossAgentTask(taskRunsPath);

    await withStateDir(root, async () => {
      loadTaskRegistryStateFromSqlite();
      closeOpenClawStateDatabaseForTest();
      const sqlite = requireNodeSqlite();
      const db = new sqlite.DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
      try {
        db.prepare(
          `INSERT INTO task_runs (
            task_id,
            runtime,
            requester_session_key,
            owner_key,
            scope_kind,
            child_session_key,
            agent_id,
            requester_agent_id,
            run_id,
            task,
            status,
            delivery_status,
            notify_policy,
            created_at,
            last_event_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "legacy-cross-agent",
          "subagent",
          "agent:main:main",
          "agent:main:main",
          "session",
          "agent:worker:subagent:child",
          "worker",
          "other-requester",
          "legacy-cross-agent-run",
          "Inspect worker state",
          "running",
          "pending",
          "done_only",
          130,
          140,
        );
      } finally {
        db.close();
      }
    });

    const result = await autoMigrateLegacyTaskStateSidecars({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(result.warnings).toContain(
      "Left task registry sidecar in place because 1 row already existed in shared state: legacy-cross-agent",
    );
    expect(fs.existsSync(taskRunsPath)).toBe(true);
  });

  it("keeps task sidecars when shared state already has conflicting task rows", async () => {
    const root = await makeTempRoot();
    const { taskRunsPath, flowRunsPath } = writeLegacyTaskStateSidecars(root);

    await withStateDir(root, async () => {
      const sqlite = requireNodeSqlite();
      const sharedPath = path.join(root, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
      const db = new sqlite.DatabaseSync(sharedPath);
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS task_runs (
            task_id TEXT NOT NULL PRIMARY KEY,
            runtime TEXT NOT NULL,
            task_kind TEXT,
            source_id TEXT,
            requester_session_key TEXT,
            owner_key TEXT NOT NULL,
            scope_kind TEXT NOT NULL,
            child_session_key TEXT,
            parent_flow_id TEXT,
            parent_task_id TEXT,
            agent_id TEXT,
            run_id TEXT,
            label TEXT,
            task TEXT NOT NULL,
            status TEXT NOT NULL,
            delivery_status TEXT NOT NULL,
            notify_policy TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            ended_at INTEGER,
            last_event_at INTEGER,
            cleanup_after INTEGER,
            error TEXT,
            progress_summary TEXT,
            terminal_summary TEXT,
            terminal_outcome TEXT
          );
        `);
        db.prepare(`
          INSERT INTO task_runs (
            task_id, runtime, requester_session_key, owner_key, scope_kind, task, status,
            delivery_status, notify_policy, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "legacy-task",
          "cron",
          "",
          "system:cron:nightly",
          "system",
          "Different task",
          "running",
          "not_applicable",
          "silent",
          100,
        );
      } finally {
        db.close();
      }
    });

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([
      "Left task registry sidecar in place because 1 row already existed in shared state: legacy-task",
    ]);
    expect(fs.existsSync(taskRunsPath)).toBe(true);
    expect(fs.existsSync(`${taskRunsPath}.migrated`)).toBe(false);
    expect(fs.existsSync(flowRunsPath)).toBe(false);
    expect(fs.existsSync(`${flowRunsPath}.migrated`)).toBe(true);
  });

  it("routes legacy state to the default agent entry", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "alpha", default: true }] },
    };
    writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
      },
    });

    const targetDir = path.join(root, "agents", "alpha", "sessions");
    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:alpha:main"]?.sessionId).toBe("a");
  });

  it("honors session.mainKey when seeding the direct-chat bucket", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = { session: { mainKey: "work" } };
    writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
        "+1666": { sessionId: "b", updatedAt: 20 },
      },
    });

    const targetDir = path.join(root, "agents", "main", "sessions");
    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:work"]?.sessionId).toBe("b");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("canonicalizes legacy main keys inside the target sessions store", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
      "agent:main:main": { sessionId: "fresh", updatedAt: 20 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["main"]).toBeUndefined();
    expect(store["agent:main:main"]?.sessionId).toBe("fresh");
  });

  it("prefers the newest entry when collapsing main aliases", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = { session: { mainKey: "work" } };
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": { sessionId: "legacy", updatedAt: 50 },
      "agent:main:work": { sessionId: "canonical", updatedAt: 10 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:work"]?.sessionId).toBe("legacy");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("lowercases agent session keys during canonicalization", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:slack:channel:C123": { sessionId: "legacy", updatedAt: 10 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:slack:channel:c123"]?.sessionId).toBe("legacy");
    expect(store["agent:main:slack:channel:C123"]).toBeUndefined();
  });

  it("preserves Matrix room and thread casing during canonicalization", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:Matrix:Channel:!Mixed:Example.Org:Thread:$EventABC": {
        sessionId: "matrix",
        updatedAt: 10,
      },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:matrix:channel:!Mixed:Example.Org:thread:$EventABC"]?.sessionId).toBe(
      "matrix",
    );
    expect(store["agent:main:matrix:channel:!mixed:example.org:thread:$eventabc"]).toBeUndefined();
  });

  it("preserves unscoped legacy Matrix room casing when scoping to an agent", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "Matrix:Channel:!Mixed:Example.Org": { sessionId: "matrix", updatedAt: 10 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:matrix:channel:!Mixed:Example.Org"]?.sessionId).toBe("matrix");
    expect(store["agent:main:matrix:channel:!mixed:example.org"]).toBeUndefined();
  });

  it("auto-migrates when only target sessions contain legacy keys", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
    });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({ root, cfg });

    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();
    expect(store["main"]).toBeUndefined();
    expect(store["agent:main:main"]?.sessionId).toBe("legacy");
  });

  it("does nothing when no legacy state dir exists", async () => {
    const root = await makeTempRoot();
    const result = await runStateDirMigration(root);

    expect(result.migrated).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it("skips state dir migration when env override is set", async () => {
    const root = await makeTempRoot();
    const { legacyDir } = getStateDirMigrationPaths(root);
    fs.mkdirSync(legacyDir, { recursive: true });

    const result = await runStateDirMigration(root, {
      OPENCLAW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv);

    expect(result.skipped).toBe(true);
    expect(result.migrated).toBe(false);
  });

  it("classifies already-migrated symlink mirrors without warnings", async () => {
    const flatRoot = await makeTempRoot();
    const flat = ensureLegacyAndTargetStateDirs(flatRoot);
    fs.mkdirSync(path.join(flat.targetDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(flat.targetDir, "agent"), { recursive: true });
    fs.symlinkSync(
      path.join(flat.targetDir, "sessions"),
      path.join(flat.legacyDir, "sessions"),
      DIR_LINK_TYPE,
    );
    fs.symlinkSync(
      path.join(flat.targetDir, "agent"),
      path.join(flat.legacyDir, "agent"),
      DIR_LINK_TYPE,
    );
    expectUnmigratedWithoutWarnings(await runFreshStateDirMigration(flatRoot));

    const nestedRoot = await makeTempRoot();
    const nested = ensureLegacyAndTargetStateDirs(nestedRoot);
    fs.mkdirSync(path.join(nested.targetDir, "agents", "main"), { recursive: true });
    fs.mkdirSync(path.join(nested.legacyDir, "agents"), { recursive: true });
    fs.symlinkSync(
      path.join(nested.targetDir, "agents", "main"),
      path.join(nested.legacyDir, "agents", "main"),
      DIR_LINK_TYPE,
    );
    expectUnmigratedWithoutWarnings(await runFreshStateDirMigration(nestedRoot));
  });

  it("warns when target exists and legacy state is not a safe mirror", async () => {
    const emptyRoot = await makeTempRoot();
    const empty = ensureLegacyAndTargetStateDirs(emptyRoot);
    expectTargetAlreadyExistsWarning(await runFreshStateDirMigration(emptyRoot), empty.targetDir);

    const fileRoot = await makeTempRoot();
    const file = ensureLegacyAndTargetStateDirs(fileRoot);
    fs.writeFileSync(path.join(file.legacyDir, "sessions.json"), "{}", "utf-8");
    expectTargetAlreadyExistsWarning(await runFreshStateDirMigration(fileRoot), file.targetDir);

    const outsideRoot = await makeTempRoot();
    const outside = ensureLegacyAndTargetStateDirs(outsideRoot);
    const outsideDir = path.join(outsideRoot, ".outside-state");
    fs.mkdirSync(path.join(outside.targetDir, "sessions"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(outside.legacyDir, "sessions"), DIR_LINK_TYPE);
    expectTargetAlreadyExistsWarning(
      await runFreshStateDirMigration(outsideRoot),
      outside.targetDir,
    );

    const brokenRoot = await makeTempRoot();
    const broken = ensureLegacyAndTargetStateDirs(brokenRoot);
    const targetSessionDir = path.join(broken.targetDir, "sessions");
    fs.mkdirSync(targetSessionDir, { recursive: true });
    fs.symlinkSync(targetSessionDir, path.join(broken.legacyDir, "sessions"), DIR_LINK_TYPE);
    fs.rmSync(targetSessionDir, { recursive: true, force: true });
    expectTargetAlreadyExistsWarning(await runFreshStateDirMigration(brokenRoot), broken.targetDir);

    const secondHopRoot = await makeTempRoot();
    const secondHop = ensureLegacyAndTargetStateDirs(secondHopRoot);
    const secondHopOutsideDir = path.join(secondHopRoot, ".outside-state");
    fs.mkdirSync(secondHopOutsideDir, { recursive: true });
    const targetHop = path.join(secondHop.targetDir, "hop");
    fs.symlinkSync(secondHopOutsideDir, targetHop, DIR_LINK_TYPE);
    fs.symlinkSync(targetHop, path.join(secondHop.legacyDir, "sessions"), DIR_LINK_TYPE);
    expectTargetAlreadyExistsWarning(
      await runFreshStateDirMigration(secondHopRoot),
      secondHop.targetDir,
    );
  });
});
