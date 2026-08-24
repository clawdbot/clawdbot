// Managed-service update handoff starts a detached process that can finish an
// update after the gateway exits under launchd/systemd-style supervisors.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../daemon/launchd-label.js";
import { resolveLaunchAgentPlistPath } from "../daemon/launchd-service-files.js";
import { findInstalledSystemdGatewayScope } from "../daemon/systemd-scope.js";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import { forceKillChildProcessTree } from "../process/child-process-tree.js";
import {
  getFileLockProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
} from "../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveNodeSqliteLocation } from "./node-sqlite.js";
import type { GatewayRestartIntent } from "./restart-intent.js";
import { SUPERVISOR_HINT_ENV_VARS, type RespawnSupervisor } from "./supervisor-markers.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import type { UpdateChannel } from "./update-channels.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  type ControlPlaneUpdateSentinelMetaFile,
} from "./update-control-plane-sentinel.js";
import { applyDevUpdateTargetEnv, type DevUpdateTarget } from "./update-dev-target.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "./update-managed-service-handoff-cleanup.js";
import type { UpdateRestartSentinelMeta } from "./update-restart-sentinel-payload.js";

// The helper deadline covers scheduled restart delay, the full Gateway drain
// budget, and its bounded parent-exit shutdown reserve. (#99666)
const PARENT_EXIT_SHUTDOWN_RESERVE_MS = 30_000;
const HANDOFF_READY_TIMEOUT_MS = 30_000;
const HANDOFF_READY_MARKER = "OPENCLAW_UPDATE_HANDOFF_READY\n";
const HANDOFF_BUSY_MARKER = "HANDOFF_BUSY ";
const HANDOFF_STATE_DATABASE_BUSY_TIMEOUT_MS = 5_000;
const SERVICE_IDENTITY_ENV_VARS = new Set<string>([
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const);
type HandoffChild = ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
};
const HANDOFF_COMMAND_RUNNER_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
process.stdin.once("data", (decision) => {
  if (decision.toString() !== "go") return;
  const argv = JSON.parse(process.argv[1]);
  if (process.platform !== "win32" && typeof process.execve === "function") {
    process.execve(argv[0], argv, process.env);
  }
  const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; });
  child.once("exit", (code, signal) => {
    process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
  });
});
`;

const HANDOFF_SCRIPT = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const params = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(params.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(params.logPath, "[" + new Date().toISOString() + "] " + line + "\n", {
      mode: 0o600,
    });
  } catch {
    // Best effort only.
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    return Boolean(err && err.code !== "ESRCH");
  }
  if (process.platform === "linux") {
    try {
      const status = fs.readFileSync("/proc/" + pid + "/status", "utf8");
      return !/^State:\s+Z/m.test(status);
    } catch {
      return true;
    }
  }
  return true;
}

function readProcessStartIdentity(pid) {
  if (!isPidAlive(pid)) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const commEndIndex = stat.lastIndexOf(")");
      if (commEndIndex < 0) return null;
      const fields = stat.slice(commEndIndex + 1).trimStart().split(/\s+/);
      const starttime = Number(fields[19]);
      return Number.isInteger(starttime) && starttime >= 0 ? String(starttime) : null;
    } catch {
      return null;
    }
  }
  const windows = process.platform === "win32";
  if (!windows && process.platform !== "darwin") return null;
  const args = windows
    ? ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + pid + ").StartTime.ToString('o')"]
    : ["-o", "lstart=", "-p", String(pid)];
  const result = spawnSync(windows ? "powershell.exe" : "/bin/ps", args, {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    stdio: ["ignore", "pipe", "ignore"], timeout: 1000, killSignal: "SIGKILL", windowsHide: windows,
  });
  const startedAt = Date.parse(String(result.stdout || "").trim() + (windows ? "" : " UTC"));
  return !result.error && result.status === 0 && Number.isFinite(startedAt)
    ? String(Math.floor(startedAt / (windows ? 1 : 1000)))
    : null;
}

function parseLeaseCommandIdentity(value) {
  const parsed = parseJsonColumn(value);
  return parsed &&
    parsed.version === 1 &&
    Number.isInteger(parsed.pid) &&
    parsed.pid > 0 &&
    typeof parsed.startIdentity === "string" && parsed.startIdentity.length > 0
    ? parsed
    : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupSensitiveFiles() {
  for (const filePath of params.sensitivePaths || []) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort only.
    }
  }
}

// Keep this self-contained helper aligned with resolveImmutableSqliteFileUri;
// the detached script cannot import the TypeScript runtime after replacement.
function resolveImmutableStateDatabaseUri(databasePath) {
  if (process.platform === "win32") {
    const namespacedPath = path.toNamespacedPath(path.resolve(databasePath));
    return "file:" + encodeURIComponent(namespacedPath) + "?mode=ro&immutable=1";
  }
  return pathToFileURL(path.resolve(databasePath)).href + "?mode=ro&immutable=1";
}

function assertStateDatabaseWriteAllowed(database) {
  if (
    !params.stateDatabasePath ||
    typeof params.stateDatabasePath !== "string" ||
    (!database && !fs.existsSync(params.stateDatabasePath))
  ) {
    return;
  }
  const ownsDatabase = !database;
  let db = database;
  if (!db) {
    const sqlite = require("node:sqlite");
    db = new sqlite.DatabaseSync(resolveImmutableStateDatabaseUri(params.stateDatabasePath), {
      readOnly: true,
    });
  }
  try {
    if (ownsDatabase) {
      db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    }
    const table = db
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'config_machine_state' LIMIT 1")
      .get();
    if (!table) return;
    const row = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'gateway.supervision' LIMIT 1")
      .get();
    if (!row) return;
    const value = parseJsonColumn(row.value_json);
    const keys = value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
    if (
      keys.join(",") !== "claimedAt,managerId,mode,version" ||
      value.version !== 1 ||
      value.mode !== "external" ||
      typeof value.managerId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.managerId) ||
      !Number.isSafeInteger(value.claimedAt) ||
      value.claimedAt < 0 ||
      value.claimedAt > 8640000000000000
    ) {
      throw new Error("shared-state ownership metadata is malformed");
    }
    if ((process.env.OPENCLAW_SUPERVISOR_MODE || "").trim().toLowerCase() !== "external") {
      throw new Error(
        "shared state is externally supervised by " +
          value.managerId +
          "; use that external supervisor with OPENCLAW_SUPERVISOR_MODE=external",
      );
    }
  } finally {
    if (ownsDatabase) {
      db.close();
    }
  }
}

function openStateDatabase() {
  if (!params.stateDatabasePath || typeof params.stateDatabasePath !== "string") {
    return null;
  }
  let db = null;
  try {
    assertStateDatabaseWriteAllowed();
    const sqlite = require("node:sqlite");
    fs.mkdirSync(path.dirname(params.stateDatabasePath), { recursive: true, mode: 0o700 });
    db = new sqlite.DatabaseSync(params.nodeSqliteLocation);
    db.exec("PRAGMA busy_timeout = ${HANDOFF_STATE_DATABASE_BUSY_TIMEOUT_MS};");
    runManagedUpdateLeaseTransaction(db, () => {
      assertStateDatabaseWriteAllowed(db);
      db.exec([
        "CREATE TABLE IF NOT EXISTS gateway_restart_sentinel (",
        "sentinel_key TEXT NOT NULL PRIMARY KEY,",
        "version INTEGER NOT NULL,",
        "kind TEXT NOT NULL,",
        "status TEXT NOT NULL,",
        "ts INTEGER NOT NULL,",
        "session_key TEXT,",
        "thread_id TEXT,",
        "delivery_channel TEXT,",
        "delivery_to TEXT,",
        "delivery_account_id TEXT,",
        "message TEXT,",
        "continuation_json TEXT,",
        "doctor_hint TEXT,",
        "stats_json TEXT,",
        "payload_json TEXT NOT NULL,",
        "updated_at_ms INTEGER NOT NULL",
        ") STRICT;",
        "CREATE INDEX IF NOT EXISTS idx_gateway_restart_sentinel_ts",
        "ON gateway_restart_sentinel(ts DESC, sentinel_key);",
      ].join(" "));
      const columns = new Set(db.prepare("PRAGMA table_info(gateway_restart_sentinel)").all().map((row) => row.name));
      for (const column of ["delivery_channel", "delivery_to", "delivery_account_id", "message", "continuation_json", "doctor_hint", "stats_json"]) {
        if (!columns.has(column)) db.exec("ALTER TABLE gateway_restart_sentinel ADD COLUMN " + column + " TEXT;");
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.chmodSync(params.stateDatabasePath + suffix, 0o600); } catch {}
      }
    });
    return db;
  } catch (err) {
    try {
      db?.close();
    } catch {}
    appendLog("failed to open restart sentinel database: " + (err && err.stack ? err.stack : String(err)));
    return null;
  }
}

// This profile-independent SQLite coordinator owns one updater per canonical
// install root. Process identity, not time, controls stale takeover.
let managedUpdateLease = null;
let managedUpdateLeaseOwned = false;

function assertManagedUpdateLeasePath(stat, label, expectedKind) {
  const validKind = expectedKind === "directory" ? stat.isDirectory() : stat.isFile();
  if (!validKind || stat.isSymbolicLink()) {
    throw new Error("managed update lease " + label + " is not a safe " + expectedKind);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && typeof stat.uid === "number" && stat.uid !== uid) {
    throw new Error("managed update lease " + label + " is owned by another user");
  }
  if (process.platform !== "win32" && typeof stat.mode === "number" && (stat.mode & 0o077) !== 0) {
    throw new Error("managed update lease " + label + " permissions are too broad");
  }
}

function openManagedUpdateLeaseDatabase() {
  const databasePath =
    typeof params.updateLeaseDatabasePath === "string"
      ? params.updateLeaseDatabasePath.trim()
      : "";
  if (!databasePath) {
    throw new Error("managed update lease database path is unavailable");
  }
  const sqlite = require("node:sqlite");
  const databaseDir = path.dirname(databasePath);
  fs.mkdirSync(databaseDir, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(databaseDir);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
  ) {
    throw new Error("managed update lease directory is unsafe");
  }
  fs.chmodSync(databaseDir, 0o700);
  assertManagedUpdateLeasePath(fs.lstatSync(databaseDir), "directory", "directory");
  if (fs.existsSync(databasePath)) {
    assertManagedUpdateLeasePath(fs.lstatSync(databasePath), "database", "file");
  }
  const db = new sqlite.DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = ${HANDOFF_STATE_DATABASE_BUSY_TIMEOUT_MS};");
  db.exec([
    "CREATE TABLE IF NOT EXISTS managed_update_handoffs (",
    "install_root TEXT NOT NULL PRIMARY KEY,",
    "owner TEXT NOT NULL,",
    "payload_json TEXT NOT NULL,",
    "updated_at INTEGER NOT NULL",
    ") STRICT;",
  ].join(" "));
  fs.chmodSync(databasePath, 0o600);
  assertManagedUpdateLeasePath(fs.lstatSync(databasePath), "database", "file");
  return db;
}

function runManagedUpdateLeaseTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {}
    throw err;
  }
}

function buildLeaseProcessPayload(pid) {
  const startIdentity = readProcessStartIdentity(pid);
  if (!startIdentity) throw new Error("managed update process start identity is unavailable");
  return JSON.stringify({
    version: 1,
    pid,
    startIdentity,
  });
}

function acquireManagedUpdateLease() {
  const key = typeof params.updateLeaseKey === "string" ? params.updateLeaseKey.trim() : "";
  const owner = typeof params.updateLeaseOwner === "string" ? params.updateLeaseOwner.trim() : "";
  if (!key || !owner) {
    throw new Error("managed update lease identity is unavailable");
  }
  const db = openManagedUpdateLeaseDatabase();
  try {
    const result = runManagedUpdateLeaseTransaction(db, () => {
      const current = db
        .prepare(
          "SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?",
        )
        .get(key);
      const currentIdentity = current && parseLeaseCommandIdentity(current.payload_json);
      if (current && !currentIdentity) {
        throw new Error("existing managed update lease process identity is invalid");
      }
      if (currentIdentity && isPidAlive(currentIdentity.pid) &&
        (readProcessStartIdentity(currentIdentity.pid) || currentIdentity.startIdentity) === currentIdentity.startIdentity) {
        return {
          acquired: false,
          owner: typeof current.owner === "string" ? current.owner : undefined,
        };
      }
      if (current) {
        db.prepare(
          "DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?",
        ).run(key, current.owner);
      }
      const now = Date.now();
      db.prepare(
        [
          "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at)",
          "VALUES (?, ?, ?, ?)",
        ].join(" "),
      ).run(key, owner, buildLeaseProcessPayload(process.pid), now);
      return { acquired: true };
    });
    if (!result.acquired) {
      db.close();
      return result;
    }
    managedUpdateLease = { db, key, owner };
    managedUpdateLeaseOwned = true;
    return result;
  } catch (err) {
    try {
      db.close();
    } catch {}
    throw err;
  }
}

function bindManagedUpdateLeaseToProcess(pid, expectedIdentity, nextIdentity = buildLeaseProcessPayload(pid)) {
  const lease = managedUpdateLease;
  if (!lease || !managedUpdateLeaseOwned || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    const updated = lease.db.prepare(
      "UPDATE managed_update_handoffs SET payload_json = ?, updated_at = ? " +
        "WHERE install_root = ? AND owner = ?" + (expectedIdentity ? " AND payload_json = ?" : ""),
    ).run(nextIdentity, Date.now(), lease.key, lease.owner,
      ...(expectedIdentity ? [expectedIdentity] : []));
    if (updated.changes !== 1) throw new Error("managed update lease process binding was lost");
    return true;
  } catch (err) {
    managedUpdateLeaseOwned = false;
    appendLog(
      "managed update lease binding failed: " +
        (err && err.stack ? err.stack : String(err)),
    );
    return false;
  }
}

function ownsManagedUpdateLease() {
  const lease = managedUpdateLease;
  if (!lease || !managedUpdateLeaseOwned) return false;
  const row = lease.db
    .prepare("SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?")
    .get(lease.key);
  const identity = row && row.owner === lease.owner ? parseLeaseCommandIdentity(row.payload_json) : null;
  return Boolean(identity && identity.pid === process.pid &&
    identity.startIdentity === readProcessStartIdentity(process.pid));
}

function releaseManagedUpdateLease() {
  const lease = managedUpdateLease;
  managedUpdateLease = null;
  if (!lease) {
    return;
  }
  try {
    if (managedUpdateLeaseOwned) {
      lease.db.prepare(
        "DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?",
      ).run(lease.key, lease.owner);
    }
  } catch (err) {
    appendLog(
      "managed update lease release failed: " +
        (err && err.stack ? err.stack : String(err)),
    );
  } finally {
    managedUpdateLeaseOwned = false;
    try {
      lease.db.close();
    } catch {}
  }
}

function parseJsonColumn(value) {
  try {
    return typeof value === "string" && value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function readRestartSentinelRecord(db) {
  const row = db
    .prepare(
      [
        "SELECT version, kind, status, ts, session_key, thread_id,",
        "delivery_channel, delivery_to, delivery_account_id, message, continuation_json,",
        "doctor_hint, stats_json, updated_at_ms",
        "FROM gateway_restart_sentinel WHERE sentinel_key = ?",
      ].join(" "),
    )
    .get("current");
  if (
    !row ||
    row.version !== 1 ||
    typeof row.kind !== "string" ||
    typeof row.status !== "string" ||
    typeof row.ts !== "number" ||
    typeof row.updated_at_ms !== "number"
  ) {
    return null;
  }
  const payload = {
    kind: row.kind,
    status: row.status,
    ts: row.ts,
  };
  if (typeof row.session_key === "string") payload.sessionKey = row.session_key;
  if (typeof row.thread_id === "string") payload.threadId = row.thread_id;
  const deliveryContext = {};
  if (typeof row.delivery_channel === "string") deliveryContext.channel = row.delivery_channel;
  if (typeof row.delivery_to === "string") deliveryContext.to = row.delivery_to;
  if (typeof row.delivery_account_id === "string") deliveryContext.accountId = row.delivery_account_id;
  if (Object.keys(deliveryContext).length > 0) payload.deliveryContext = deliveryContext;
  if (typeof row.message === "string") payload.message = row.message;
  const continuation = parseJsonColumn(row.continuation_json);
  if (continuation) payload.continuation = continuation;
  if (typeof row.doctor_hint === "string") payload.doctorHint = row.doctor_hint;
  const stats = parseJsonColumn(row.stats_json);
  if (stats) payload.stats = stats;
  return { revision: row.updated_at_ms, payload };
}

function writeRestartSentinelPayload(db, payload, currentRevision) {
  const floor = db.prepare(
    "SELECT updated_at_ms FROM gateway_restart_sentinel WHERE sentinel_key = 'revision-floor'",
  ).get();
  if (floor && !Number.isSafeInteger(floor.updated_at_ms)) {
    throw new Error("restart sentinel revision floor is outside the safe integer range");
  }
  const updatedAtMs = Math.max(Date.now(), Math.max(currentRevision || 0, floor?.updated_at_ms || 0) + 1);
  if (!Number.isSafeInteger(updatedAtMs)) {
    throw new Error("restart sentinel revision exhausted the safe integer range");
  }
  const values = [
    payload.kind,
    payload.status,
    payload.ts,
    payload.sessionKey || null,
    payload.threadId || null,
    payload.deliveryContext && typeof payload.deliveryContext.channel === "string"
      ? payload.deliveryContext.channel
      : null,
    payload.deliveryContext && typeof payload.deliveryContext.to === "string"
      ? payload.deliveryContext.to
      : null,
    payload.deliveryContext && typeof payload.deliveryContext.accountId === "string"
      ? payload.deliveryContext.accountId
      : null,
    payload.message || null,
    payload.continuation ? JSON.stringify(payload.continuation) : null,
    payload.doctorHint || null,
    payload.stats ? JSON.stringify(payload.stats) : null,
    JSON.stringify(payload),
    updatedAtMs,
  ];
  let changed;
  if (currentRevision === null) {
    changed = db.prepare(
      [
        "INSERT INTO gateway_restart_sentinel (",
        "sentinel_key, version, kind, status, ts, session_key, thread_id,",
        "delivery_channel, delivery_to, delivery_account_id, message, continuation_json,",
        "doctor_hint, stats_json, payload_json, updated_at_ms",
        ") VALUES ('current', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    ).run(...values).changes === 1;
  } else {
    changed = db.prepare(
      [
        "UPDATE gateway_restart_sentinel SET",
        "version = 1, kind = ?, status = ?, ts = ?, session_key = ?, thread_id = ?,",
        "delivery_channel = ?, delivery_to = ?, delivery_account_id = ?, message = ?,",
        "continuation_json = ?, doctor_hint = ?, stats_json = ?, payload_json = ?, updated_at_ms = ?",
        "WHERE sentinel_key = 'current' AND updated_at_ms = ?",
      ].join(" "),
    ).run(...values, currentRevision).changes === 1;
  }
  if (changed) {
    // This runs inside the same BEGIN IMMEDIATE section as the guarded current-row write.
    const floorPayload = JSON.stringify({ kind: "restart", status: "skipped", ts: updatedAtMs });
    db.prepare(
      [
        "INSERT INTO gateway_restart_sentinel (",
        "sentinel_key, version, kind, status, ts, session_key, thread_id,",
        "delivery_channel, delivery_to, delivery_account_id, message, continuation_json,",
        "doctor_hint, stats_json, payload_json, updated_at_ms",
        ") VALUES ('revision-floor', 1, 'restart', 'skipped', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)",
        "ON CONFLICT(sentinel_key) DO UPDATE SET",
        "ts = excluded.ts, payload_json = excluded.payload_json, updated_at_ms = excluded.updated_at_ms",
      ].join(" "),
    ).run(updatedAtMs, floorPayload, updatedAtMs);
  }
  return changed;
}

function markUpdateSentinelFailureIfPending(reason, restored) {
  let metaFile;
  try {
    metaFile = JSON.parse(fs.readFileSync(params.metaPath, "utf-8"));
  } catch {}
  const meta = metaFile && metaFile.version === 1 && metaFile.meta ? metaFile.meta : {};
  const fallbackPayload = {
    kind: "update",
    status: "error",
    ts: Date.now(),
    message: typeof meta.note === "string" ? meta.note : null,
    stats: {
      mode: "unknown",
      ...(typeof meta.root === "string" && meta.root.trim() ? { root: meta.root } : {}),
      ...(typeof meta.handoffId === "string" && meta.handoffId.trim()
        ? { handoffId: meta.handoffId }
        : {}),
      reason,
      steps: [],
      durationMs: 0,
    },
  };
  for (const key of ["sessionKey", "threadId"]) {
    if (typeof meta[key] === "string" && meta[key].trim()) fallbackPayload[key] = meta[key];
  }
  if (meta.deliveryContext && typeof meta.deliveryContext === "object") {
    fallbackPayload.deliveryContext = meta.deliveryContext;
  }
  const db = openStateDatabase();
  if (!db) return false;
  let recorded = false;
  try {
    runManagedUpdateLeaseTransaction(db, () => {
      assertStateDatabaseWriteAllowed(db);
      const current = readRestartSentinelRecord(db);
      let payload = current && current.payload;
      const handoffId = typeof params.handoffId === "string" ? params.handoffId.trim() : "";
      if (
        (payload && (payload.kind !== "update" || payload.status !== "skipped" ||
          !["managed-service-handoff-started", "restart-health-pending"].includes(payload.stats?.reason)) &&
          !(typeof restored === "boolean" && payload.kind === "update" && payload.status === "error")) ||
        (payload && handoffId && (!payload.stats || payload.stats.handoffId !== handoffId))
      ) {
        return;
      }
      if (payload) {
        payload = { ...payload, status: "error" };
        delete payload.continuation;
        payload.stats = { ...(payload.stats || {}), reason };
      } else {
        payload = fallbackPayload;
      }
      if (typeof restored === "boolean") {
        payload.stats.steps = [
          ...(payload.stats.steps || []),
          { name: "service-restore", command: params.serviceRecovery.kind, log: { exitCode: restored ? 0 : 1 } },
        ];
      }
      if (!writeRestartSentinelPayload(db, payload, current ? current.revision : null)) {
        throw new Error("restart sentinel changed before guarded failure write");
      }
      recorded = true;
    });
  } catch (err) {
    appendLog("failed to write update sentinel failure: " + (err && err.stack ? err.stack : String(err)));
  } finally {
    try {
      db.close();
    } catch {}
  }
  return recorded;
}

function runServiceCommand(command, args, onSpawn, deadline) {
  if (!ownsManagedUpdateLease()) return Promise.resolve({ code: 1, stdout: "", stderr: "" });
  return new Promise((resolve) => {
    const cap = args[0] === "bootout" ? ${PARENT_EXIT_SHUTDOWN_RESERVE_MS} : 5000;
    const remaining = deadline === undefined ? cap : deadline - Date.now();
    if (remaining <= 0) return resolve({ code: 1, stdout: "", stderr: "" });
    let stdout = "", stderr = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"], killSignal: "SIGKILL",
      timeout: Math.min(cap, remaining),
    });
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk).slice(-8192); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.once("spawn", () => onSpawn?.());
    child.once("error", (error) => { stderr = String(error); });
    child.once("close", (code) => resolve({ code: typeof code === "number" ? code : 1, stdout, stderr }));
  });
}

async function inspectSystemdService(unit) {
  const result = await runServiceCommand("systemctl", ["--user", "show", unit,
    "--property=Id,LoadState,ActiveState,MainPID,ExecMainStartTimestampMonotonic"]);
  if (result.code !== 0) return null;
  return Object.fromEntries(result.stdout.trim().split(/\r?\n/).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function isLaunchdNotLoaded(result) {
  return /no such process|could not find service|not found/i.test(result.stderr || result.stdout);
}

let parkedServiceGeneration = null;
let restorationArmed = false;
let pendingServiceStop;

async function parkGatewayService() {
  const recovery = params.serviceRecovery;
  if (!recovery || recovery.kind === "schtasks") return;
  if (readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
    throw new Error("managed update parent identity changed before parking");
  }
  if (recovery.kind === "systemd") {
    const current = await inspectSystemdService(recovery.unit);
    if (!current || current.Id !== recovery.unit || current.LoadState !== "loaded" ||
      current.ActiveState !== "active" || current.MainPID !== String(params.parentPid) ||
      !/^[1-9]\d*$/.test(current.ExecMainStartTimestampMonotonic || "") ||
      !ownsManagedUpdateLease() ||
      readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
      throw new Error("systemd service does not match the exact active gateway parent");
    }
    parkedServiceGeneration = current.ExecMainStartTimestampMonotonic;
    // A submitted stop can kill its parent even when the transport later times out.
    restorationArmed = true;
    const stopped = await runServiceCommand("systemctl", ["--user", "--no-block", "stop", recovery.unit]);
    if (stopped.code !== 0) throw new Error("systemd stop submission failed: " + stopped.stderr);
    return;
  }
  if (recovery.kind !== "launchd") throw new Error("unsupported managed update supervisor");
  const target = "gui/" + recovery.uid + "/" + recovery.label;
  const inspection = await runServiceCommand("launchctl", ["print", target]);
  const parentMatch = /^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(inspection.stdout);
  if (inspection.code !== 0 || Number(parentMatch?.[1]) !== params.parentPid ||
    !ownsManagedUpdateLease() ||
    readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
    throw new Error("launchd service does not match the exact active gateway parent");
  }
  restorationArmed = true;
  const disabled = await runServiceCommand("launchctl", ["disable", target]);
  if (disabled.code !== 0) throw new Error("launchctl disable failed: " + disabled.stderr);
  if (!ownsManagedUpdateLease() ||
    readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
    throw new Error("managed update owner changed before launchd bootout");
  }
  // bootout gets launchd's full teardown budget; its accepted spawn acknowledges parking.
  await new Promise((resolve, reject) => {
    pendingServiceStop = runServiceCommand("launchctl", ["bootout", target], resolve);
    pendingServiceStop.then((result) => {
      if (result.code !== 0 && !isLaunchdNotLoaded(result)) {
        reject(new Error("launchctl bootout failed: " + result.stderr));
      }
    });
  });
}

async function restoreGatewayService(reason) {
  const recovery = params.serviceRecovery;
  let restored = false;
  if (recovery?.kind === "systemd") {
    const run = (args) => runServiceCommand("systemctl", ["--user", ...args]);
    await run(["reset-failed", recovery.unit]);
    const started = await run(["start", recovery.unit]);
    const current = started.code === 0 && await inspectSystemdService(recovery.unit);
    restored = Boolean(current && current.Id === recovery.unit &&
      current.LoadState === "loaded" && current.ActiveState === "active" &&
      /^[1-9]\d*$/.test(current.MainPID || "") && current.MainPID !== String(params.parentPid) &&
      isPidAlive(Number(current.MainPID)) &&
      /^[1-9]\d*$/.test(current.ExecMainStartTimestampMonotonic || "") &&
      current.ExecMainStartTimestampMonotonic !== parkedServiceGeneration);
  } else if (recovery?.kind === "launchd") {
    const target = "gui/" + recovery.uid + "/" + recovery.label;
    const deadline = Date.now() + ${PARENT_EXIT_SHUTDOWN_RESERVE_MS};
    const run = (args) => runServiceCommand("launchctl", args, undefined, deadline);
    const enabled = await run(["enable", target]);
    let kickstarted = false;
    for (let inspection = enabled; enabled.code === 0 && Date.now() < deadline;) {
      inspection = await run(["print", target]);
      if (inspection.code === 0) {
        const pid = Number(/^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(inspection.stdout)?.[1]);
        if (pid !== params.parentPid && isPidAlive(pid)) {
          restored = true;
          break;
        }
        // launchd retains the old label until its ExitTimeOut-bounded teardown completes.
        if (pid === params.parentPid) {
          await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
          continue;
        }
        if (kickstarted) break;
        kickstarted = true;
        inspection = await run(["kickstart", target]);
      } else if (isLaunchdNotLoaded(inspection)) {
        inspection = await run(["bootstrap", "gui/" + recovery.uid, recovery.plistPath]);
      } else break;
      if (inspection.code === 0) continue;
      const detail = inspection.stderr || inspection.stdout;
      if (inspection.code === 130 ||
        /already exists in domain|operation already in progress|bootstrap failed: 37/i.test(detail)) continue;
      if (kickstarted && isLaunchdNotLoaded(inspection)) continue;
      if (!/bootstrap failed: 5|input\/output error/i.test(detail)) break;
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  } else if (recovery?.kind === "schtasks") {
    restored = (await runServiceCommand("schtasks.exe", ["/Run", "/TN", recovery.taskName])).code === 0;
  }
  appendLog("gateway service recovery " + (restored ? "succeeded" : "failed"));
  const recorded = markUpdateSentinelFailureIfPending(
    restored ? reason : "managed-service-handoff-restore-failed", restored,
  );
  if (!recorded) {
    appendLog("managed update restoration result could not be durably recorded");
  }
  return restored && recorded;
}

(async () => {
  if (!Number.isInteger(params.parentPid) || params.parentPid <= 0 ||
    typeof params.parentStartIdentity !== "string" || !params.parentStartIdentity) {
    throw new Error("managed update parent process identity is unavailable");
  }
  if (isPidAlive(params.parentPid) &&
    readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
    throw new Error("managed update parent process identity changed");
  }
  if (!Number.isFinite(params.parentExitTimeoutMs) || params.parentExitTimeoutMs < 0 ||
    !Number.isFinite(params.parentExitDeadlineAt)) {
    throw new Error("managed update parent exit deadline is unavailable");
  }
  const lease = acquireManagedUpdateLease();
  if (!lease.acquired) {
    appendLog(
      "managed update handoff joined active owner=" + (lease.owner || "unknown"),
    );
    cleanupSensitiveFiles();
    fs.writeSync(1, ${JSON.stringify(HANDOFF_BUSY_MARKER)} + (lease.owner || "") + "\n");
    await sleep(25);
    return;
  }
  let outcome;
  let wake;
  let deadlineExpired = false;
  const parentExitDeadline = setTimeout(() => {
    deadlineExpired = true;
    if (outcome !== "update") outcome = "restore";
    wake?.();
  }, params.parentExitTimeoutMs);
  try {
    fs.writeSync(1, ${JSON.stringify(HANDOFF_READY_MARKER)});
    const commands = [];
    let input = "";
    let disconnected = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.length > 64) return process.stdin.destroy();
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        if (commands.length >= 4) return process.stdin.destroy();
        commands.push(input.slice(0, newline));
        input = input.slice(newline + 1);
      }
      wake?.();
    });
    process.stdin.once("close", () => {
      disconnected = true;
      wake?.();
    });
    const reply = (line) => fs.writeSync(1, line + "\n");
    let parked = false;
    while (isPidAlive(params.parentPid)) {
      if (!ownsManagedUpdateLease()) throw new Error("managed update lease no longer owns the helper");
      if (readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
        if (isPidAlive(params.parentPid)) throw new Error("managed update parent process identity changed");
        await new Promise((resolve) => setImmediate(resolve));
        if (!commands.length) break;
      }
      if (deadlineExpired) {
        deadlineExpired = false;
        if (!parked) {
          await parkGatewayService();
          parked = true;
        }
        if (ownsManagedUpdateLease() &&
          readProcessStartIdentity(params.parentPid) === params.parentStartIdentity) {
          try { process.kill(params.parentPid, "SIGKILL"); } catch {}
        }
      }
      const command = commands.shift();
      if (command === "park") {
        try {
          if (!parked) await parkGatewayService();
          parked = true;
          reply("parked");
        } catch (error) {
          appendLog("managed service parking failed: " + String(error));
          if (restorationArmed) {
            outcome = "restore";
            reply("restore-after-exit");
          } else {
            markUpdateSentinelFailureIfPending("managed-service-handoff-cancelled");
            reply("cancelled");
            return;
          }
        }
      } else if (command === "commit" && parked) {
        const restoring = outcome === "restore" || Date.now() >= params.parentExitDeadlineAt;
        outcome = restoring ? "restore" : "update";
        reply(restoring ? "restore-after-exit" : "committed");
      } else if (command === "cancel" || (disconnected && outcome !== "update")) {
        if (!restorationArmed) {
          markUpdateSentinelFailureIfPending("managed-service-handoff-cancelled");
          if (command) reply("cancelled");
          return;
        }
        outcome = "restore";
        if (command) reply("restore-after-exit");
      } else if (command === "restore-commit" && outcome === "restore") {
        reply("committed");
      } else if (command) {
        throw new Error("invalid managed update control command");
      }
      await Promise.race([sleep(25), new Promise((resolve) => { wake = resolve; })]);
    }
    clearTimeout(parentExitDeadline);
    const stopped = pendingServiceStop ? await pendingServiceStop : null;
    if (stopped && stopped.code !== 0 && !isLaunchdNotLoaded(stopped)) {
      throw new Error("launchctl bootout failed: " + stopped.stderr);
    }
    if (outcome !== "update") {
      if (restorationArmed) await restoreGatewayService("managed-service-handoff-cancelled");
      else markUpdateSentinelFailureIfPending("managed-service-handoff-cancelled");
      return;
    }
    if (params.serviceRecovery?.kind === "systemd") {
      const unit = params.serviceRecovery.unit;
      const current = await inspectSystemdService(unit);
      if (!current || current.Id !== unit || current.LoadState !== "loaded" ||
        current.ActiveState !== "inactive" || current.MainPID !== "0" ||
        current.ExecMainStartTimestampMonotonic !== parkedServiceGeneration) {
        throw new Error("systemd service remained active or changed execution generation");
      }
    }
    if (params.serviceRecovery?.kind === "launchd") {
      const target = "gui/" + params.serviceRecovery.uid + "/" + params.serviceRecovery.label;
      const deadline = Date.now() + ${PARENT_EXIT_SHUTDOWN_RESERVE_MS};
      for (;;) {
        const result = await runServiceCommand("launchctl", ["print", target], undefined, deadline);
        if (result.code !== 0) {
          if (!isLaunchdNotLoaded(result)) throw new Error("launchctl print failed: " + result.stderr);
          break;
        }
        if (Date.now() >= deadline) throw new Error("launchd service remained loaded after parent exit");
        await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      }
    }

    appendLog("starting managed update command: " + params.commandLabel);
    let outputFd;
    try {
      outputFd = fs.openSync(params.logPath, "a", 0o600);
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(HANDOFF_COMMAND_RUNNER_SCRIPT)}, JSON.stringify(params.commandArgv)], {
        cwd: params.cwd,
        env: process.env,
        detached: true,
        stdio: ["pipe", outputFd, outputFd],
      });
      const exited = new Promise((resolve) => {
        child.once("error", (err) => resolve({ error: err }));
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      child.stdin.on("error", () => {});
      const runnerIdentity = buildLeaseProcessPayload(child.pid);
      if (!bindManagedUpdateLeaseToProcess(child.pid, undefined, runnerIdentity)) {
        try {
          child.kill("SIGKILL");
        } catch {}
        await exited;
        throw new Error("managed update runner lease binding failed");
      }
      try {
        await new Promise((resolve, reject) => {
          child.stdin.once("error", reject);
          child.stdin.once("close", () => reject(new Error("managed update runner stdin closed")));
          child.once("exit", () => reject(new Error("managed update runner exited before its gate")));
          child.stdin.write("go", (error) => error ? reject(error) : resolve());
        });
        child.stdin.end();
      } catch (error) {
        try { child.kill("SIGKILL"); } catch {}
        await exited;
        bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity);
        throw error;
      }
      appendLog("managed update command pid=" + (child.pid || "unknown"));
      const exit = await exited;
      if (!bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity)) {
        process.exitCode = 1;
        return;
      }
      if (exit && exit.error) {
        appendLog("managed update command failed to start: " + (exit.error && exit.error.stack ? exit.error.stack : String(exit.error)));
        if (params.serviceRecovery) await restoreGatewayService("managed-service-handoff-spawn-failed");
        else markUpdateSentinelFailureIfPending("managed-service-handoff-spawn-failed");
        process.exitCode = 1;
        return;
      }
      appendLog(
        "managed update command exited code=" +
          (exit && exit.code !== null && exit.code !== undefined ? exit.code : "null") +
          " signal=" +
          (exit && exit.signal ? exit.signal : "null"),
      );
      if (exit && (exit.signal || (typeof exit.code === "number" && exit.code !== 0))) {
        if (params.serviceRecovery) await restoreGatewayService("managed-service-handoff-failed");
        else markUpdateSentinelFailureIfPending("managed-service-handoff-failed");
        process.exitCode = exit.code || 1;
      }
    } finally {
      if (outputFd !== undefined) {
        try {
          fs.closeSync(outputFd);
        } catch {
          // Ignore close failures.
        }
      }
    }
  } catch (err) {
    appendLog("handoff failed: " + (err && err.stack ? err.stack : String(err)));
    if (managedUpdateLeaseOwned) {
      bindManagedUpdateLeaseToProcess(process.pid);
      if (restorationArmed) await restoreGatewayService("managed-service-handoff-helper-failed");
      else markUpdateSentinelFailureIfPending("managed-service-handoff-helper-failed");
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(parentExitDeadline);
    releaseManagedUpdateLease();
    process.stdin.destroy();
    cleanupSensitiveFiles();
  }
})().catch((err) => {
  appendLog("handoff setup failed: " + (err && err.stack ? err.stack : String(err)));
  cleanupSensitiveFiles();
  process.exitCode = 1;
});
`;

type ManagedServiceUpdateHandoffParams = {
  root: string;
  timeoutMs?: number;
  restartDrainTimeoutMs: number;
  restartDelayMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  meta: UpdateRestartSentinelMeta;
  handoffId?: string;
  supervisor?: RespawnSupervisor | null;
  env?: NodeJS.ProcessEnv;
  devTarget?: DevUpdateTarget;
  execPath?: string;
  argv1?: string;
  parentPid?: number;
};

type ManagedServiceUpdateHandoffResult = {
  pid?: number;
  command: string;
  logPath: string;
} & (
  | { status: "started"; handoffId: string; installRoot: string }
  | { status: "joined"; handoffId?: string }
);

type ActiveManagedServiceUpdateHandoff = {
  handoffId: string;
  flight?: Promise<ManagedServiceUpdateHandoffResult>;
  launcher?: HandoffChild;
  launcherStartIdentity?: number | null;
  helper?: { owner: string; pid: number; startIdentity: string };
  claimed?: boolean;
  cancelling?: boolean;
  exited?: boolean;
};
const activeManagedServiceUpdateHandoffs = new Map<string, ActiveManagedServiceUpdateHandoff>();

function resolveUpdateCliArgv(params: {
  timeoutMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  execPath?: string;
  argv1?: string;
}): string[] {
  const updateArgs = ["update", "--yes", "--json"];
  if (params.channel) {
    updateArgs.push("--channel", params.channel);
  }
  if (params.tag) {
    updateArgs.push("--tag", params.tag);
  }
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    updateArgs.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000))));
  }

  const execPath = params.execPath?.trim();
  const argv1 = params.argv1?.trim();
  if (execPath && argv1) {
    return [execPath, argv1, ...updateArgs];
  }
  if (execPath && !/^(?:node|bun)(?:\.exe)?$/iu.test(path.basename(execPath))) {
    return [execPath, ...updateArgs];
  }
  return ["openclaw", ...updateArgs];
}

export function formatManagedServiceUpdateCommand(params?: {
  timeoutMs?: number;
  channel?: UpdateChannel;
  tag?: string;
}): string {
  return resolveUpdateCliArgv(params ?? {})
    .toSpliced(3, 1)
    .join(" ");
}

type GatewayServiceRecovery =
  | { kind: "systemd"; unit: string }
  | { kind: "launchd"; uid: number; label: string; plistPath: string }
  | { kind: "schtasks"; taskName: string };

function resolveGatewayServiceRecovery(
  supervisor: RespawnSupervisor | null | undefined,
  env: NodeJS.ProcessEnv,
): GatewayServiceRecovery | undefined {
  if (supervisor === "systemd") {
    return { kind: "systemd", unit: `${resolveSystemdServiceName(env)}.service` };
  }
  if (supervisor === "launchd") {
    const label = resolveLaunchAgentLabel(env);
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    return { kind: "launchd", uid, label, plistPath: resolveLaunchAgentPlistPath(env) };
  }
  if (supervisor === "schtasks") {
    const taskName =
      env.OPENCLAW_WINDOWS_TASK_NAME?.trim() || resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
    return { kind: "schtasks", taskName };
  }
  return undefined;
}

function resolveManagedUpdateLeaseDatabasePath(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite");
}

function waitForHandoffResponse(child: HandoffChild, command?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const output = child.stdout;
    let settled = false;
    let buffered = "";
    const finish = (result: string | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.removeListener("error", finish);
      child.removeListener("exit", onExit);
      output.removeListener("data", onData);
      output.removeListener("error", onOutputError);
      child.stdin.removeListener("error", finish).removeListener("close", onInputClose);
      if (result instanceof Error) {
        if (!command) {
          output.destroy();
        }
        reject(result);
      } else {
        resolve(result);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `managed update handoff exited before ${command ? "responding" : "signaling readiness"} (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    };
    const onOutputError = (err: Error) => {
      if (!command && child.pid) {
        // A loaded helper is armed even when its readiness marker was lost.
        forceKillChildProcessTree(child);
      }
      finish(err);
    };
    const onInputClose = () => finish(new Error("managed update handoff control input closed"));
    const onData = (chunk: Buffer | string) => {
      buffered = `${buffered}${chunk.toString()}`.slice(-1024);
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        finish(buffered.slice(0, newline));
      }
    };
    const timeout = setTimeout(() => {
      const phase = command ? "respond" : "signal readiness";
      onOutputError(new Error(`managed update handoff did not ${phase} within 30 seconds`));
    }, HANDOFF_READY_TIMEOUT_MS);

    child.once("error", finish).once("exit", onExit);
    output.once("error", onOutputError).on("data", onData);
    child.stdin.once("error", finish).once("close", onInputClose);
    if (command) {
      child.stdin.write(`${command}\n`, (error) => {
        if (error) {
          finish(error);
        }
      });
    }
  });
}

async function spawnManagedServiceUpdateHandoff(
  params: ManagedServiceUpdateHandoffParams & { handoffId: string },
  rootIdentity: string,
  owner: ActiveManagedServiceUpdateHandoff,
): Promise<ManagedServiceUpdateHandoffResult> {
  const parentPid = params.parentPid ?? process.pid;
  const parentStartIdentity = getFileLockProcessStartTime(parentPid);
  if (parentStartIdentity === null) {
    throw new Error("managed update parent process start identity is unavailable");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX));
  const scriptPath = path.join(dir, "handoff.cjs");
  const paramsPath = path.join(dir, "handoff.json");
  const metaPath = path.join(dir, "sentinel-meta.json");
  const logPath = path.join(dir, "handoff.log");
  const commandArgv = resolveUpdateCliArgv({
    timeoutMs: params.timeoutMs,
    channel: params.channel,
    tag: params.tag,
    execPath: params.execPath ?? process.execPath,
    argv1: params.argv1 ?? process.argv[1],
  });
  const commandLabel = formatManagedServiceUpdateCommand({
    timeoutMs: params.timeoutMs,
    channel: params.channel,
    tag: params.tag,
  });
  const metaFile: ControlPlaneUpdateSentinelMetaFile = {
    version: 1,
    meta: { ...params.meta, root: rootIdentity },
  };
  const serviceEnv = params.env ?? process.env;
  let spawnCommand = params.execPath ?? process.execPath;
  const spawnArgs = [scriptPath, paramsPath];
  if (params.supervisor === "systemd") {
    const systemdRun = resolveExecutableFromPathEnv(
      "systemd-run",
      [serviceEnv.PATH ?? "", "/usr/bin", "/bin"].join(path.delimiter),
      serviceEnv,
    );
    if (!systemdRun) {
      throw new Error("systemd-run is required to launch a transient user scope");
    }
    const normalized = params.handoffId.trim().replace(/[^A-Za-z0-9_.:@-]+/gu, "-");
    const suffix =
      normalized.replace(/^-+|-+$/gu, "").slice(0, 80) || `${process.pid}-${Date.now()}`;
    spawnArgs.unshift(
      "--user",
      "--scope",
      "--collect",
      `--unit=openclaw-update-${suffix}.scope`,
      spawnCommand,
    );
    spawnCommand = systemdRun;
  }
  const stateDatabasePath = resolveOpenClawStateSqlitePath(serviceEnv);
  const parentExitTimeoutMs = Math.min(
    2_147_483_647,
    Math.max(0, params.restartDelayMs ?? 0) +
      Math.max(0, params.restartDrainTimeoutMs) +
      PARENT_EXIT_SHUTDOWN_RESERVE_MS,
  );
  const helperParams = {
    parentPid,
    parentStartIdentity: String(parentStartIdentity),
    parentExitTimeoutMs,
    parentExitDeadlineAt: Date.now() + parentExitTimeoutMs,
    cwd: dir,
    commandArgv,
    commandLabel,
    handoffId: params.handoffId,
    logPath,
    metaPath,
    stateDatabasePath,
    nodeSqliteLocation: resolveNodeSqliteLocation(stateDatabasePath),
    updateLeaseDatabasePath: resolveManagedUpdateLeaseDatabasePath(),
    updateLeaseKey: rootIdentity,
    updateLeaseOwner: params.handoffId,
    sensitivePaths: [scriptPath, paramsPath, metaPath],
    serviceRecovery: resolveGatewayServiceRecovery(params.supervisor, serviceEnv),
  };

  let child!: HandoffChild;
  let readiness!: string;
  const onExit = () => {
    // Keep exact ownership until cancellation proves the durable lease was released.
    owner.exited = true;
  };
  try {
    await fs.writeFile(scriptPath, `${HANDOFF_SCRIPT}\n`, { mode: 0o700 });
    await fs.writeFile(paramsPath, `${JSON.stringify(helperParams, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(metaPath, `${JSON.stringify(metaFile, null, 2)}\n`, { mode: 0o600 });

    const childEnv: NodeJS.ProcessEnv = {
      ...serviceEnv,
      [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
      OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    };
    for (const key of SUPERVISOR_HINT_ENV_VARS) {
      if (!SERVICE_IDENTITY_ENV_VARS.has(key)) {
        delete childEnv[key];
      }
    }
    const env = params.devTarget ? applyDevUpdateTargetEnv(childEnv, params.devTarget) : childEnv;
    child = spawn(spawnCommand, spawnArgs, {
      cwd: dir,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    owner.launcher = child;
    child.stdin.on("error", () => child.stdin.destroy()).once("close", () => child.stdin.destroy());
    owner.launcherStartIdentity = child.pid ? getFileLockProcessStartTime(child.pid) : null;
    if (owner.launcherStartIdentity == null) {
      forceKillChildProcessTree(child);
      throw new Error("managed update handoff process start identity is unavailable");
    }
    child.once("exit", onExit);
    // systemd-run --scope remains synchronous until the helper exits, so this
    // child's exit owns the full handoff lifetime. The ready marker means the
    // helper owns the cross-process update lease before callers terminate the Gateway.
    readiness = await waitForHandoffResponse(child);
    if (`${readiness}\n` !== HANDOFF_READY_MARKER && !readiness.startsWith(HANDOFF_BUSY_MARKER)) {
      throw new Error("managed update handoff returned an invalid readiness response");
    }
    if (`${readiness}\n` === HANDOFF_READY_MARKER) {
      const helper = readManagedServiceUpdateHandoffLease(rootIdentity);
      if (
        helper?.owner !== params.handoffId ||
        !isPidAlive(helper.pid) ||
        getFileLockProcessStartTime(helper.pid)?.toString() !== helper.startIdentity
      ) {
        forceKillChildProcessTree(child);
        throw new Error("managed update handoff helper lease identity is unavailable");
      }
      owner.helper = helper;
    }
  } catch (err) {
    child?.removeListener("exit", onExit);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  child.unref();

  const result = { command: commandLabel, logPath };
  const handoffId = readiness.slice(HANDOFF_BUSY_MARKER.length).trim();
  return `${readiness}\n` === HANDOFF_READY_MARKER
    ? {
        ...result,
        status: "started",
        ...(child.pid ? { pid: child.pid } : {}),
        handoffId: params.handoffId,
        installRoot: rootIdentity,
      }
    : {
        ...result,
        status: "joined",
        ...(handoffId ? { handoffId } : {}),
      };
}

export async function startManagedServiceUpdateHandoff(
  params: ManagedServiceUpdateHandoffParams,
): Promise<ManagedServiceUpdateHandoffResult> {
  if (
    !Number.isFinite(params.restartDrainTimeoutMs) ||
    !Number.isFinite(params.restartDelayMs ?? 0)
  ) {
    throw new Error("managed update handoff requires a finite restart deadline");
  }
  if (
    params.supervisor === "systemd" &&
    (await findInstalledSystemdGatewayScope(params.env ?? process.env))?.scope === "system"
  ) {
    throw new Error(
      "Managed update handoff requires a user-scope systemd unit; perform a manual system-service update.",
    );
  }
  const root = resolveUpdateInstallRoot(params.root);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  if (active?.flight && (!active.exited || active.claimed || active.cancelling)) {
    const joined = await active.flight;
    return {
      status: "joined",
      command: joined.command,
      logPath: joined.logPath,
      ...(joined.pid ? { pid: joined.pid } : {}),
      ...(joined.handoffId ? { handoffId: joined.handoffId } : {}),
    };
  }
  const owner: ActiveManagedServiceUpdateHandoff = { handoffId: params.handoffId ?? randomUUID() };
  activeManagedServiceUpdateHandoffs.set(root, owner);
  const flight = spawnManagedServiceUpdateHandoff(
    {
      ...params,
      handoffId: owner.handoffId,
      meta: {
        ...params.meta,
        handoffId: params.meta.handoffId ?? owner.handoffId,
      },
    },
    root,
    owner,
  );
  owner.flight = flight;
  try {
    return await flight;
  } catch (err) {
    if (activeManagedServiceUpdateHandoffs.get(root) === owner) {
      activeManagedServiceUpdateHandoffs.delete(root);
    }
    throw err;
  }
}

export function claimManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): boolean {
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  const launcher = active?.launcher;
  const helper = active?.helper;
  const lease = readManagedServiceUpdateHandoffLease(root);
  if (
    identity.kind !== "managed-update-handoff" ||
    active?.handoffId !== identity.handoffId ||
    !launcher?.pid ||
    !isPidAlive(launcher.pid) ||
    active.launcherStartIdentity == null ||
    getFileLockProcessStartTime(launcher.pid) !== active.launcherStartIdentity ||
    launcher.exitCode !== null ||
    launcher.signalCode !== null ||
    active.cancelling ||
    lease?.owner !== identity.handoffId ||
    helper?.owner !== identity.handoffId ||
    lease.pid !== helper.pid ||
    lease.startIdentity !== helper.startIdentity ||
    !isPidAlive(lease.pid) ||
    getFileLockProcessStartTime(lease.pid)?.toString() !== lease.startIdentity
  ) {
    return false;
  }
  active.claimed = true;
  return true;
}

function readManagedServiceUpdateHandoffLease(
  root: string,
  stale?: ActiveManagedServiceUpdateHandoff,
): { owner: string; pid: number; startIdentity: string } | null | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = openNodeSqliteDatabase(resolveManagedUpdateLeaseDatabasePath(), { readOnly: !stale });
    const lease = getNodeSqliteKysely<{
      managed_update_handoffs: { install_root: string; owner: string; payload_json: string };
    }>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      lease
        .selectFrom("managed_update_handoffs")
        .select(["owner", "payload_json"])
        .where("install_root", "=", root),
    );
    if (!row) {
      return null;
    }
    const payload: unknown = JSON.parse(row.payload_json);
    if (
      !isRecord(payload) ||
      Object.keys(payload).length !== 3 ||
      payload.version !== 1 ||
      typeof payload.pid !== "number" ||
      !Number.isInteger(payload.pid) ||
      payload.pid <= 0 ||
      typeof payload.startIdentity !== "string" ||
      !payload.startIdentity
    ) {
      return undefined;
    }
    const current = { owner: row.owner, pid: payload.pid, startIdentity: payload.startIdentity };
    if (!stale) {
      return current;
    }
    const observedStart = getFileLockProcessStartTime(current.pid);
    if (
      current.owner !== stale.handoffId ||
      current.pid !== stale.helper?.pid ||
      current.startIdentity !== stale.helper.startIdentity ||
      (!isPidDefinitelyDead(current.pid) &&
        (observedStart === null || String(observedStart) === current.startIdentity))
    ) {
      return current;
    }
    const deleted = executeSqliteQueryTakeFirstSync(
      db,
      lease
        .deleteFrom("managed_update_handoffs")
        .where("install_root", "=", root)
        .where("owner", "=", current.owner)
        .where("payload_json", "=", row.payload_json)
        .returning("owner"),
    );
    return deleted ? null : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function sendManagedServiceUpdateHandoffCommand(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
  command: string,
): Promise<string | null> {
  const child = activeManagedServiceUpdateHandoffs.get(
    resolveUpdateInstallRoot(identity.installRoot),
  )?.launcher;
  if (!child?.stdin || !child.stdout || child.stdin.destroyed) {
    return Promise.resolve(null);
  }
  return waitForHandoffResponse(child, command).catch(() => null);
}

export async function requestManagedServiceUpdateHandoffPark(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<boolean> {
  return (
    claimManagedServiceUpdateHandoff(identity) &&
    (await sendManagedServiceUpdateHandoffCommand(identity, "park")) === "parked" &&
    claimManagedServiceUpdateHandoff(identity)
  );
}

export async function commitManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
  outcome: "update" | "restore" = "update",
): Promise<boolean> {
  return (
    claimManagedServiceUpdateHandoff(identity) &&
    (await sendManagedServiceUpdateHandoffCommand(
      identity,
      outcome === "update" ? "commit" : "restore-commit",
    )) === "committed"
  );
}

export async function cancelManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<"restored-in-process" | "restart-after-exit" | false> {
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  if (
    identity.kind !== "managed-update-handoff" ||
    active?.handoffId !== identity.handoffId ||
    active.cancelling
  ) {
    return false;
  }
  active.cancelling = true;
  try {
    const child = active.launcher;
    if (child && !active.exited && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      const response = await sendManagedServiceUpdateHandoffCommand(identity, "cancel");
      if (response === "restore-after-exit") {
        return "restart-after-exit";
      }
      if (response !== "cancelled" && !active.exited && !child.stdin.destroyed) {
        return false;
      }
      await exited;
    }
    if (
      readManagedServiceUpdateHandoffLease(root, active) !== null ||
      activeManagedServiceUpdateHandoffs.get(root) !== active
    ) {
      return false;
    }
    activeManagedServiceUpdateHandoffs.delete(root);
    return "restored-in-process";
  } catch {
    return false;
  } finally {
    active.cancelling = false;
  }
}

export function buildManagedServiceHandoffUnavailableMessage(command: string): string {
  return [
    "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.",
    `Run \`${command}\` from a shell outside the gateway service, or restart/update from the host UI.`,
  ].join("\n");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
