// Readiness/transfer timeouts finish before online staging, validation and ten-minute repair.
// Only park waits the restart delay, then starts the parent-exit deadline and supervisor stop.
// After the exact parent exits, parked permits activation, migration and successor verification.
// No-op updates and failed validation leave the serving parent untouched.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatCliCommand } from "../cli/command-format.js";
import { formatInstallationTargetCommand } from "../cli/installation-target-format.js";
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
import { SKIPPED_UPDATE_OUTCOMES } from "../shared/update-outcome.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { resolveInstallationTarget } from "./installation-target-context.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveNodeSqliteLocation } from "./node-sqlite.js";
import type { GatewayRestartIntent } from "./restart-intent.js";
import { SUPERVISOR_HINT_ENV_VARS, type RespawnSupervisor } from "./supervisor-markers.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import type { UpdateChannel } from "./update-channels.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE,
  readControlPlaneUpdateSentinelMeta,
  UPDATE_RUN_ID_ENV,
  type ControlPlaneUpdateSentinelMetaFile,
} from "./update-control-plane-sentinel.js";
import { applyDevUpdateTargetEnv, type DevUpdateTarget } from "./update-dev-target.js";
import { verifyPackageUpdateRecovery } from "./update-global.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "./update-managed-service-handoff-cleanup.js";
import { resolveManagedUpdateRequester } from "./update-requester-authority.js";
import type { UpdateRestartSentinelMeta } from "./update-restart-sentinel-payload.js";
import { readCurrentGitUpdateRecovery } from "./update-runner-git-recovery.js";
import { looksLikeGitCheckout } from "./update-runner-install-surface.js";

// The activation deadline covers Gateway drain plus this shutdown reserve.
const PARENT_EXIT_SHUTDOWN_RESERVE_MS = 30_000;
const HANDOFF_READY_TIMEOUT_MS = 30_000;
const HANDOFF_READY_MARKER = "OPENCLAW_UPDATE_HANDOFF_READY\n";
const HANDOFF_BUSY_MARKER = "HANDOFF_BUSY ";
const HANDOFF_ACTIVATION_MARKER = "park\n";
const HANDOFF_NOTICE_MARKER = "before-park\n";
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
    process.stdin.pause();
    process.execve(argv[0], argv, process.env);
  }
  // A paused Node reader can still buffer data. Only this runner reads the
  // helper pipe; a spawned successor receives post-go bytes through its own pipe.
  const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: ["pipe", "inherit", "inherit"] });
  child.once("error", () => { process.stdin.destroy(); process.exitCode = 1; });
  child.once("exit", (code, signal) => {
    process.stdin.destroy();
    process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
  });
  if (child.stdin) {
    child.stdin.on("error", () => process.stdin.destroy());
    process.stdin.pipe(child.stdin);
  }
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
let ownedCommandIdentity;
let activeCommand;
let updateCancelled = false;
let activationRejected;

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
  return Boolean(identity &&
    (identity.pid === process.pid || row.payload_json === ownedCommandIdentity) &&
    identity.startIdentity === readProcessStartIdentity(identity.pid));
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
  return changed ? updatedAtMs : null;
}

let triageFailure;
let runLedger;
let runOutcome;
let serviceStoppedAtMs;
let serviceDowntimeMs;

function isFailedUpdateOutcome(status, reason) {
  return status === "error" || (status === "skipped" &&
    !params.nonFailureSkippedReasons.includes(reason));
}

function captureFailedUpdateResult() {
  // Enrich an already recorded failure; diagnostic artifacts never decide the
  // update outcome or permission to restart the service.
  if (fs.existsSync(params.triageContextPath)) {
    triageFailure = { ...triageFailure, reason: "managed-service-handoff-failed" };
    return true;
  }
  const db = openStateDatabase();
  if (!db) return false;
  try {
    const payload = readRestartSentinelRecord(db)?.payload;
    if (payload?.kind !== "update" || payload.stats?.handoffId !== params.handoffId ||
      !isFailedUpdateOutcome(payload.status, payload.stats?.reason)) return false;
    triageFailure = { ...triageFailure, payload, reason: payload.stats.reason || "managed-service-handoff-failed" };
    return true;
  } finally {
    db.close();
  }
}

function recordUpdateHandoffOutcome(reason, restored, completedStatus, expectedRevision) {
  if (!ownsManagedUpdateLease()) return false;
  let metaFile;
  try {
    metaFile = JSON.parse(fs.readFileSync(params.metaPath, "utf-8"));
  } catch {}
  const meta = metaFile && metaFile.version === 1 && metaFile.meta ? metaFile.meta : {};
  const status = (reason === "managed-service-handoff-cancelled" || completedStatus === "skipped") && restored !== false
    ? "skipped" : "error";
  runOutcome = { status: status === "error" ? "failed" : "skipped", reason };
  const fallbackPayload = {
    kind: "update",
    status,
    ts: Date.now(),
    message: typeof meta.note === "string" ? meta.note : null,
    stats: {
      mode: "unknown",
      ...(typeof meta.runId === "string" && meta.runId.trim() ? { runId: meta.runId } : {}),
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
  if (status === "error") triageFailure ??= { payload: fallbackPayload, reason };
  if (triageFailure && typeof restored === "boolean") triageFailure.restored = restored;
  const db = openStateDatabase();
  if (!db) return null;
  let recorded = null;
  try {
    runManagedUpdateLeaseTransaction(db, () => {
      assertStateDatabaseWriteAllowed(db);
      const current = readRestartSentinelRecord(db);
      if (expectedRevision !== undefined && (!current || current.revision !== expectedRevision)) {
        recorded = true;
        return;
      }
      let payload = current && current.payload;
      // A completed child attempts publication before recovery. A missing row
      // may already be consumed; do not retry its best-effort notification here.
      if (completedStatus && !payload) { recorded = true; return; }
      const handoffId = typeof params.handoffId === "string" ? params.handoffId.trim() : "";
      if (
        (payload && (payload.kind !== "update" || (!isFailedUpdateOutcome(payload.status, payload.stats?.reason) &&
          (payload.status !== "skipped" || (completedStatus !== "skipped" &&
            !["managed-service-handoff-started", "restart-health-pending", "managed-service-handoff-cancelled"].includes(payload.stats?.reason)))))) ||
        (payload && handoffId && (!payload.stats || payload.stats.handoffId !== handoffId)) ||
        (payload?.stats?.root && payload.stats.root !== params.updateLeaseKey)
      ) {
        return;
      }
      if (payload) {
        const failed = isFailedUpdateOutcome(payload.status, payload.stats?.reason);
        const preserveChildStatus = completedStatus === payload.status && restored !== false;
        // A failed attempt keeps its reason when recovery turns a skipped status into an error.
        payload = {
          ...payload,
          status: payload.status === "error" || preserveChildStatus ? payload.status : status,
          stats: { ...(payload.stats || {}), reason: failed || preserveChildStatus ? payload.stats?.reason ?? reason : reason },
        };
        delete payload.continuation;
      } else {
        payload = fallbackPayload;
      }
      if (isFailedUpdateOutcome(payload.status, payload.stats?.reason)) {
        payload.doctorHint = params.triageHint;
        triageFailure ??= { reason };
        triageFailure.payload = payload;
      }
      runOutcome = { status: payload.status === "error" ? "failed" : "skipped", reason: payload.stats?.reason ?? reason };
      if (typeof restored === "boolean") {
        payload.stats.steps = [
          ...(payload.stats.steps || []),
          { name: "service-restore", command: params.serviceRecovery.kind,
            log: { exitCode: restored ? 0 : 1, ...(completedStatus && !restored ? { stderrTail: reason } : {}) } },
        ];
      }
      recorded = writeRestartSentinelPayload(db, payload, current ? current.revision : null);
      if (recorded === null) {
        throw new Error("restart sentinel changed before guarded failure write");
      }
      if (triageFailure) triageFailure.payload = payload;
    });
  } catch (err) {
    recorded = null;
    appendLog("failed to write update sentinel failure: " + (err && err.stack ? err.stack : String(err)));
  } finally {
    try {
      db.close();
    } catch {}
  }
  return recorded;
}

function runServiceCommand(command, args, onSpawn, deadline, timeoutCap) {
  if (!ownsManagedUpdateLease()) return Promise.resolve({ code: 1, stdout: "", stderr: "" });
  return new Promise((resolve) => {
    const cap = timeoutCap ?? (args[0] === "bootout" ? ${PARENT_EXIT_SHUTDOWN_RESERVE_MS} : 5000);
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

async function inspectSystemdService(unit, deadline) {
  const result = await runServiceCommand("systemctl", ["--user", "show", unit,
    "--property=Id,LoadState,ActiveState,MainPID,ExecMainStartTimestampMonotonic,InvocationID"], undefined, deadline);
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
let parkedServiceInvocation = null;
let restorationArmed = false;
let updaterStarted = false;
let pendingServiceStop;
let finishBeforeParkNotice;

function recordServiceStop() {
  serviceStoppedAtMs ??= Date.now();
  // Both native stop observations retain the updater phase; they do not own activation.
  pendingServiceStop?.then((stopped) => {
    runLedger?.recordUpdateRunStep(params.runId, {
      step: "service-stop", status: stopped.code === 0 || (params.serviceRecovery?.kind === "launchd" && isLaunchdNotLoaded(stopped)) ? "completed" : "failed", endedAtMs: Date.now(),
    });
  }).catch((error) => appendLog("could not record service stop completion: " + String(error)));
  try {
    const metaFile = JSON.parse(fs.readFileSync(params.metaPath, "utf-8"));
    metaFile.meta.serviceStoppedAtMs ??= serviceStoppedAtMs;
    fs.writeFileSync(params.metaPath, JSON.stringify(metaFile), { mode: 0o600 });
    runLedger?.recordUpdateRunStep(params.runId, {
      step: "service-stop", status: "in_progress", startedAtMs: metaFile.meta.serviceStoppedAtMs,
    });
  } catch (error) {
    appendLog("could not record service stop time: " + String(error));
  }
}

function assertGatewayParkOwner() {
  if (updateCancelled || !ownsManagedUpdateLease() ||
    readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
    throw new Error("managed update activation no longer owns the serving gateway");
  }
}

async function parkGatewayService() {
  const recovery = params.serviceRecovery;
  if (!recovery) return;
  assertGatewayParkOwner();
  if (recovery.kind === "schtasks") {
    pendingServiceStop = runServiceCommand("schtasks.exe", ["/End", "/TN", recovery.taskName], () => {
      restorationArmed = true;
      recordServiceStop();
    }, params.parentExitDeadlineAt, params.parentExitTimeoutMs);
    if ((await pendingServiceStop).code !== 0) throw new Error("scheduled task stop failed");
    return;
  }
  if (recovery.kind === "systemd") {
    const current = await inspectSystemdService(recovery.unit);
    if (!current || current.Id !== recovery.unit || current.LoadState !== "loaded" ||
      current.ActiveState !== "active" || current.MainPID !== String(params.parentPid) ||
      !/^[1-9]\d*$/.test(current.ExecMainStartTimestampMonotonic || "") ||
      !/^[a-f0-9]{32}$/i.test(current.InvocationID || "")) {
      throw new Error("systemd service does not match the exact active gateway parent");
    }
    assertGatewayParkOwner();
    parkedServiceGeneration = current.ExecMainStartTimestampMonotonic;
    parkedServiceInvocation = current.InvocationID;
    // Keep the exact stop job open across parent exit; its completion is the
    // authoritative systemd fact, even after inactive-unit metadata is collected.
    await new Promise((resolve, reject) => {
      pendingServiceStop = runServiceCommand(
        "systemctl",
        ["--user", "stop", recovery.unit],
        () => {
          restorationArmed = true;
          recordServiceStop();
          resolve();
        },
        params.parentExitDeadlineAt,
        params.parentExitTimeoutMs,
      );
      pendingServiceStop.then((result) => {
        if (!restorationArmed) reject(new Error("systemd stop failed: " + result.stderr));
      });
    });
    return;
  }
  if (recovery.kind !== "launchd") throw new Error("unsupported managed update supervisor");
  const target = "gui/" + recovery.uid + "/" + recovery.label;
  const inspection = await runServiceCommand("launchctl", ["print", target]);
  const parentMatch = /^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(inspection.stdout);
  if (inspection.code !== 0 || Number(parentMatch?.[1]) !== params.parentPid) {
    throw new Error("launchd service does not match the exact active gateway parent");
  }
  assertGatewayParkOwner();
  restorationArmed = true;
  const disabled = await runServiceCommand("launchctl", ["disable", target]);
  if (disabled.code !== 0) throw new Error("launchctl disable failed: " + disabled.stderr);
  assertGatewayParkOwner();
  // bootout gets launchd's full teardown budget; its accepted spawn acknowledges parking.
  await new Promise((resolve, reject) => {
    pendingServiceStop = runServiceCommand("launchctl", ["bootout", target], () => { recordServiceStop(); resolve(); });
    pendingServiceStop.then((result) => {
      if (result.code !== 0 && !isLaunchdNotLoaded(result)) {
        reject(new Error("launchctl bootout failed: " + result.stderr));
      }
    });
  });
}

async function restoreGatewayService(reason, decision = params.recovery, childStatus, previousGeneration = false) {
  let expectedRevision;
  const record = (restored) => recordUpdateHandoffOutcome(
    restored ? reason : "managed-service-handoff-restore-failed", restored, childStatus, expectedRevision,
  );
  if (decision?.serviceRestartSafe !== true || !decision.version) {
    appendLog("recovery refused: original runtime identity could not be verified");
    record(false);
    return false;
  }
  const expectedVersion = decision.version;
  const expectedBuildId = decision.buildId;
  const recovery = params.serviceRecovery;
  let restored = false;
  let serviceRunning;
  let servicePid;
  const ownsRecovery = () => {
    try { return ownsManagedUpdateLease() && fs.realpathSync(params.updateLeaseKey) === params.updateLeaseKey; }
    catch { return false; }
  };
  const runOwned = (...args) => ownsRecovery()
    ? runServiceCommand(...args) : Promise.resolve({ code: 1, stdout: "", stderr: "recovery ownership lost" });
  const restart = () => runOwnedUpdateCommand("recovery", params.recoveryCommandArgv,
    params.recoveryTimeoutMs, params.cwd, previousGeneration
      ? { ...process.env, OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1" } : process.env);
  if (!ownsRecovery()) return false;
  // Activation may consume or replace the notification. Annotate only the
  // observed revision; notification persistence never decides recovery safety.
  if (childStatus) expectedRevision = recordUpdateHandoffOutcome(reason, undefined, childStatus);
  if (recovery?.kind === "systemd") {
    if (!pendingServiceStop || (await pendingServiceStop).code !== 0) {
      appendLog("recovery refused: exact systemd stop did not complete");
      record(false);
      return false;
    }
    const parked = await inspectSystemdService(recovery.unit);
    const retained = parked?.ExecMainStartTimestampMonotonic === parkedServiceGeneration &&
      parked?.InvocationID === parkedServiceInvocation;
    const cleared = parked?.ExecMainStartTimestampMonotonic === "0" && !parked?.InvocationID;
    // An owned candidate boot can advance inactive-unit metadata. Only a verified
    // full-generation rollback permits recovering that later stopped invocation.
    if (!parked || parked.Id !== recovery.unit || parked.LoadState !== "loaded" ||
      parked.ActiveState !== "inactive" || parked.MainPID !== "0" || !(previousGeneration || retained || cleared) ||
      !ownsRecovery()) {
      appendLog("recovery refused: parked systemd service identity changed or stop is incomplete");
      record(false);
      return false;
    }
    const started = childStatus
      ? await restart()
      : await runOwned("systemctl", ["--user", "start", recovery.unit]);
    const current = ownsRecovery() && await inspectSystemdService(recovery.unit);
    const pid = /^[1-9]\d*$/.test(current?.MainPID || "") ? Number(current.MainPID) : undefined;
    serviceRunning = current && current.Id === recovery.unit
      ? current.ActiveState === "active" && isPidAlive(pid) : undefined;
    servicePid = serviceRunning ? pid : undefined;
    restored = !started.signal && started.code === 0 && Boolean(current && current.Id === recovery.unit &&
      current.LoadState === "loaded" && current.ActiveState === "active" &&
      /^[1-9]\d*$/.test(current.MainPID || "") && current.MainPID !== String(params.parentPid) &&
      isPidAlive(Number(current.MainPID)) &&
      /^[1-9]\d*$/.test(current.ExecMainStartTimestampMonotonic || "") &&
      current.ExecMainStartTimestampMonotonic !== parkedServiceGeneration);
  } else if (recovery?.kind === "launchd") {
    const target = "gui/" + recovery.uid + "/" + recovery.label;
    const deadline = Date.now() + ${PARENT_EXIT_SHUTDOWN_RESERVE_MS};
    const run = (args) => runOwned("launchctl", args, undefined, deadline);
    const before = await run(["print", target]);
    if (before.code === 0) {
      const pid = Number(/^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(before.stdout)?.[1]);
      if (pid && pid !== params.parentPid) {
        appendLog("recovery refused: launchd service has another process generation");
        record(false);
        return false;
      }
    } else if (!isLaunchdNotLoaded(before)) {
      record(false);
      return false;
    }
    if (childStatus) {
      const restarted = await restart();
      // The guarded CLI owns its restart deadline; identity inspection gets a fresh probe budget.
      const current = ownsRecovery()
        ? await runOwned("launchctl", ["print", target]) : null;
      const pid = current?.code === 0
        ? Number(/^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(current.stdout)?.[1]) : 0;
      serviceRunning = current?.code === 0 ? Boolean(pid && isPidAlive(pid)) : undefined;
      servicePid = serviceRunning ? pid : undefined;
      restored = !restarted.signal && restarted.code === 0 && Boolean(pid && pid !== params.parentPid && serviceRunning);
    } else {
    const enabled = await run(["enable", target]);
    let kickstarted = false;
    for (let inspection = enabled; enabled.code === 0 && Date.now() < deadline;) {
      inspection = await run(["print", target]);
      if (inspection.code === 0) {
        const pid = Number(/^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(inspection.stdout)?.[1]);
        if (pid !== params.parentPid && isPidAlive(pid)) {
          restored = true;
          servicePid = pid;
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
    serviceRunning = restored;
    }
  } else if (recovery?.kind === "schtasks") {
    restored = (await runOwned("schtasks.exe", ["/Run", "/TN", recovery.taskName])).code === 0;
  }
  // Manager liveness survives a failed readiness probe, but version facts require
  // the new process to answer; never reuse the pre-activation runtime identity.
  runLedger?.recordUpdateRunVerification(params.runId, {
    serviceRunning, pid: servicePid, runningVersion: undefined, runningBuildId: undefined, versionMatch: undefined,
    readyz: undefined, settled: undefined, channelsReady: undefined, pluginErrors: undefined, inferenceProbe: undefined,
  });
  if (restored) {
    try {
      const { waitForGatewayUpdateRecovery } = await import(pathToFileURL(params.recoveryModulePath).href);
      if (!ownsRecovery()) throw new Error("managed update recovery ownership was lost");
      const health = await waitForGatewayUpdateRecovery(expectedVersion, expectedBuildId);
      restored = ownsRecovery() && health.healthy === true &&
        health.runtime?.status === "running" && health.gatewayVersion === expectedVersion &&
        (!expectedBuildId || health.gatewayBuildId === expectedBuildId);
      if (restored && serviceStoppedAtMs !== undefined) serviceDowntimeMs = Math.max(0, Date.now() - serviceStoppedAtMs);
      runLedger?.recordUpdateRunVerification(params.runId, {
        serviceRunning: health.runtime?.status === "running",
        pid: typeof health.runtime?.pid === "number" ? health.runtime.pid : undefined,
        runningVersion: health.gatewayVersion ?? undefined,
        runningBuildId: health.gatewayBuildId ?? undefined,
        versionMatch: health.gatewayVersion === expectedVersion && (!expectedBuildId || health.gatewayBuildId === expectedBuildId),
        settled: health.healthy === true,
        channelsReady: health.healthy === true && !health.channelProbeErrors?.length,
        pluginErrors: health.activatedPluginErrors?.map((error) => JSON.stringify(error)) ?? [],
      });
    } catch (error) {
      appendLog("Gateway recovery readiness failed: " + String(error));
      restored = false;
    }
  }
  appendLog("gateway service recovery " + (restored ? "succeeded (readiness and runtime identity verified)" : "failed"));
  const recorded = record(restored);
  if (!recorded) {
    appendLog("managed update restoration result could not be durably recorded");
  }
  return restored;
}

async function finishGatewayServicePark() {
  const stopped = pendingServiceStop ? await pendingServiceStop : null;
  if (stopped && stopped.code !== 0 && params.serviceRecovery?.kind === "launchd" &&
    !isLaunchdNotLoaded(stopped)) {
    throw new Error("launchctl bootout failed: " + stopped.stderr);
  }
  if (params.serviceRecovery?.kind === "systemd") {
    if (!stopped || stopped.code !== 0 || Date.now() >= params.parentExitDeadlineAt) {
      throw new Error("systemd stop failed or exceeded the parent-exit deadline");
    }
    const unit = params.serviceRecovery.unit;
    for (;;) {
      const current = await inspectSystemdService(unit, params.parentExitDeadlineAt);
      if (!current || current.Id !== unit || current.LoadState !== "loaded" ||
        Date.now() >= params.parentExitDeadlineAt) {
        throw new Error("systemd service remained active or changed execution generation");
      }
      if (current.ActiveState === "inactive" && current.MainPID === "0") {
        const retainedIdentity =
          current.ExecMainStartTimestampMonotonic === parkedServiceGeneration &&
          current.InvocationID === parkedServiceInvocation;
        const clearedIdentity =
          current.ExecMainStartTimestampMonotonic === "0" && !current.InvocationID;
        if (!retainedIdentity && !clearedIdentity) {
          throw new Error("systemd service remained active or changed execution generation");
        }
        break;
      }
      if (current.ActiveState !== "deactivating" || current.MainPID !== "0" ||
        current.ExecMainStartTimestampMonotonic !== parkedServiceGeneration ||
        current.InvocationID !== parkedServiceInvocation) {
        throw new Error("systemd service remained active or changed execution generation");
      }
      // The exact stop job has completed; systemd may publish inactive a moment later.
      await sleep(Math.min(25, Math.max(0, params.parentExitDeadlineAt - Date.now())));
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
  runLedger?.recordUpdateRunVerification(params.runId, { serviceRunning: false });
}

async function activateTransferredGateway() {
  const delayedUntil = Date.now() + params.restartDelayMs;
  while (Date.now() < delayedUntil) {
    if (updateCancelled || !ownsManagedUpdateLease()) throw new Error("managed update activation cancelled");
    await sleep(Math.min(250, Math.max(0, delayedUntil - Date.now())));
  }
  // The serving Gateway owns its final notice; the retained control pipe joins
  // that durable write before native stop, without extending the 10s notice bound.
  if (params.beforePark && !process.stdin.destroyed) {
    await new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); finishBeforeParkNotice = undefined; resolve(); };
      const timer = setTimeout(() => {
        appendLog("pre-park notice timed out after 10 seconds");
        finish();
      }, 10_000);
      finishBeforeParkNotice = finish;
      fs.writeSync(1, ${JSON.stringify(HANDOFF_NOTICE_MARKER)});
    });
  }
  if (params.requester) {
    const { isManagedUpdateRequesterOwner } = await import(pathToFileURL(params.recoveryModulePath).href);
    if (!(await isManagedUpdateRequesterOwner(params.requester))) {
      throw Object.assign(new Error("owner_required: chat requester is no longer a configured command owner"), { code: "owner_required" });
    }
  }
  // Validation has its own budget. The shutdown reserve starts only at activation.
  params.parentExitDeadlineAt = Date.now() + params.parentExitTimeoutMs;
  await parkGatewayService();
  while (isPidAlive(params.parentPid)) {
    if (!ownsManagedUpdateLease()) throw new Error("managed update activation ownership lost");
    if (readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
      if (!isPidAlive(params.parentPid)) break;
      throw new Error("managed update parent identity changed during activation");
    }
    if (Date.now() >= params.parentExitDeadlineAt) {
      try { process.kill(params.parentPid, "SIGKILL"); } catch {}
      throw new Error("managed update parent exit exceeded the activation deadline");
    }
    await sleep(Math.min(25, Math.max(0, params.parentExitDeadlineAt - Date.now())));
  }
  await finishGatewayServicePark();
}

function killOwnedCommand(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true, timeout: 5000,
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}

/** @param {"update" | "recovery" | "diagnostic" | "finalize"} phase */
async function runOwnedUpdateCommand(phase, commandArgv, timeoutMs, cwd = params.cwd, env = process.env) {
  const outputFd = fs.openSync(params.logPath, "a", 0o600);
  let timeout;
  const updaterChunks = [];
  let updaterBytes = 0;
  let outputOverflow = false;
  let activation;
  let activationAcknowledged = false;
  let outputPrefix = Buffer.alloc(0);
  let controlPending = phase === "update" && !restorationArmed;
  try {
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(HANDOFF_COMMAND_RUNNER_SCRIPT)}, JSON.stringify(commandArgv)], {
      cwd,
      env: phase === "update" ? { ...env, OPENCLAW_UPDATE_RUN_HANDOFF: "1" } : env,
      detached: true,
      stdio: ["pipe", "pipe", outputFd],
    });
    child.stdout.on("data", (chunk) => {
      if (controlPending) {
        outputPrefix = Buffer.concat([outputPrefix, chunk]);
        const marker = Buffer.from(${JSON.stringify(HANDOFF_ACTIVATION_MARKER)});
        if (outputPrefix.length < marker.length && marker.subarray(0, outputPrefix.length).equals(outputPrefix)) return;
        controlPending = false;
        if (outputPrefix.subarray(0, marker.length).equals(marker)) {
          chunk = outputPrefix.subarray(marker.length);
          activation = activateTransferredGateway().then(() => {
            if (!ownsManagedUpdateLease()) throw new Error("managed update activation ownership lost");
            activationAcknowledged = true;
            child.stdin.end("parked\n");
          }).catch((error) => {
            if (!activationAcknowledged) {
              activationRejected = error?.code === "owner_required" ? "owner_required" : "managed-service-handoff-helper-failed";
            }
            appendLog("managed update activation failed: " + String(error));
            child.stdin.end("cancelled\n");
            if (child.exitCode === null && child.signalCode === null) killOwnedCommand(child);
          });
        } else chunk = outputPrefix;
        outputPrefix = Buffer.alloc(0);
      }
      try { fs.writeSync(outputFd, chunk); } catch {}
      updaterBytes += chunk.length;
      if (updaterBytes > 4 * 1024 * 1024) {
        outputOverflow = true;
        updaterChunks.length = 0;
      } else updaterChunks.push(chunk);
    });
    const exited = new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdin.on("error", () => {});
    const runnerIdentity = buildLeaseProcessPayload(child.pid);
    if (!bindManagedUpdateLeaseToProcess(child.pid, undefined, runnerIdentity)) {
      killOwnedCommand(child);
      await exited;
      throw new Error("managed update runner lease binding failed");
    }
    ownedCommandIdentity = runnerIdentity;
    activeCommand = child;
    try {
      // Sending the gate can start mutation even if its write callback fails.
      // From here, only the updater can authorize recovery of this installation.
      if (phase === "update") updaterStarted = true;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          appendLog("managed update " + phase + " command exceeded its timeout");
          killOwnedCommand(child);
        }, timeoutMs);
      }
      await new Promise((resolve, reject) => {
        child.stdin.once("error", reject);
        child.stdin.once("close", () => reject(new Error("managed update runner stdin closed")));
        child.once("exit", () => reject(new Error("managed update runner exited before its gate")));
        child.stdin.write("go", (error) => error ? reject(error) : resolve());
      });
      if (!controlPending) child.stdin.end();
    } catch (error) {
      killOwnedCommand(child);
      await exited;
      bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity);
      throw error;
    }
    appendLog("managed update " + phase + " command pid=" + (child.pid || "unknown"));
    const exit = await exited;
    await activation;
    ownedCommandIdentity = undefined;
    if (!bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity)) {
      throw new Error("managed update command lease binding was lost");
    }
    if (exit.error) throw exit.error;
    appendLog("managed update " + phase + " command exited code=" + (exit.code ?? "null") + " signal=" + (exit.signal || "null"));
    // Decode after close so split UTF-8 cannot corrupt the authoritative installation root.
    return { ...exit, updaterOutput: Buffer.concat(updaterChunks).toString(), outputOverflow };
  } finally {
    activeCommand = undefined;
    ownedCommandIdentity = undefined;
    clearTimeout(timeout);
    fs.closeSync(outputFd);
  }
}

async function collectUpdateFailureTriage() {
  try {
    if (!triageFailure || !ownsManagedUpdateLease()) return;
    // Diagnostic reads share this boundary so they cannot bypass terminal cleanup.
    captureFailedUpdateResult();
    appendLog("If triage is unavailable, run " + params.triageRecoveryCommand + " on the Gateway host.");
    // The helper and outer updater start from the same installation. Preserve
    // its complete export; absent exports have only the helper's observed failure.
    const recordedFailure = fs.existsSync(params.triageContextPath);
    if (recordedFailure) {
      appendLog("Saved update failure: " + params.triageContextPath);
      appendLog("Reuse this diagnostic context on the Gateway host: " + params.triageContextCommand);
    }
    const failure = recordedFailure
      ? JSON.parse(fs.readFileSync(params.triageContextPath, "utf8"))
      : { error: "Managed update failed: " + (triageFailure.payload?.stats?.reason || triageFailure.reason) };
    const recovery = typeof triageFailure.restored === "boolean"
      ? "Service recovery " + (triageFailure.restored ? "succeeded." : "failed.")
      : "Service recovery outcome was not recorded; inspect the handoff log before restarting.";
    failure.error = [failure.error, recovery].filter(Boolean).join("\n");
    // Keep the canonical export intact even when installed triage cannot start.
    // Only this private annotated input is removed with the helper's other files.
    fs.writeFileSync(params.triageInputPath, JSON.stringify(failure), { mode: 0o600, flag: "wx" });
    appendLog("starting diagnostic-only update triage after service recovery settled");
    const exit = await runOwnedUpdateCommand(
      "diagnostic",
      [...params.triageCommandArgv, "--update-result", params.triageInputPath],
      Math.min(params.recoveryTimeoutMs, 60_000),
    );
    appendLog(!exit.signal && exit.code === 0
      ? "update triage completed; diagnostic report is above"
      : "update triage could not complete; " + params.triageHint);
  } catch (error) {
    appendLog("update triage could not complete: " + String(error) + "; " + params.triageHint);
  }
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
  let terminalRuntimePath = params.recoveryModulePath;
  let wake;
  let deadlineExpired = false;
  const parentExitDeadline = setTimeout(() => {
    deadlineExpired = true;
    if (outcome !== "update") outcome = "restore";
    wake?.();
  }, params.parentExitTimeoutMs);
  try {
    if (params.runId) {
      // Admission and stop recording use the serving runtime. Terminal writes after
      // the updater starts must load the installed runtime in a fresh process.
      runLedger = await import(pathToFileURL(params.recoveryModulePath).href);
      for (const name of ["finishUpdateRun", "getUpdateRun", "recordUpdateRunStep", "recordUpdateRunVerification"]) {
        if (typeof runLedger[name] !== "function") throw new Error("managed update ledger writer is unavailable");
      }
    }
    fs.writeSync(1, ${JSON.stringify(HANDOFF_READY_MARKER)});
    const commands = [];
    let transferred = false;
    let input = "";
    let disconnected = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.length > 64) return process.stdin.destroy();
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        if (commands.length >= 4) return process.stdin.destroy();
        const command = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (transferred && (command === "noticed" || command === "notice-failed")) {
          if (command === "notice-failed") appendLog("pre-park notice failed");
          finishBeforeParkNotice?.();
        } else if (command === "cancel" && transferred) {
          // Before activation the candidate is disposable; after parking only
          // the orchestrator may decide whether the installed tree can restart.
          if (!restorationArmed) {
            updateCancelled = true;
            if (activeCommand) killOwnedCommand(activeCommand);
            reply("cancelled");
          } else reply("cancel-unavailable");
        } else commands.push(command);
      }
      wake?.();
    });
    const onDisconnect = () => {
      disconnected = true;
      wake?.();
    };
    process.stdin.once("end", onDisconnect).once("close", onDisconnect);
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
          recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
          return;
        }
        if (ownsManagedUpdateLease() &&
          readProcessStartIdentity(params.parentPid) === params.parentStartIdentity) {
          try { process.kill(params.parentPid, "SIGKILL"); } catch {}
        }
      }
      const command = commands.shift();
      if (command === "transfer" && !parked && !transferred) {
        transferred = true;
        appendLog("managed update ownership transferred; validating while the gateway serves");
        reply("transferred");
        outcome = "update";
        break;
      } else if (command === "park") {
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
            recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
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
          recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
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
    if (outcome !== "update") {
      if (restorationArmed) await restoreGatewayService("managed-service-handoff-cancelled");
      else recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
      return;
    }
    if (restorationArmed) await finishGatewayServicePark();

    if (params.requester) {
      const { isManagedUpdateRequesterOwner } = await import(pathToFileURL(params.recoveryModulePath).href);
      if (!(await isManagedUpdateRequesterOwner(params.requester))) {
        throw Object.assign(new Error("owner_required: chat requester is no longer a configured command owner"), { code: "owner_required" });
      }
    }
    if (updateCancelled) {
      recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
      return;
    }
    appendLog("starting managed update command: " + params.commandLabel);
    // Update inputs retain shell-relative paths; recovery keeps the durable helper cwd.
    const exit = await runOwnedUpdateCommand("update", params.commandArgv, undefined, params.invocationCwd);
    if (updateCancelled || activationRejected) {
      const reason = updateCancelled ? "managed-service-handoff-cancelled" : activationRejected;
      // No parked acknowledgement authorized a swap. Recovery waits for any
      // dispatched stop, even when cancellation overlaps the parent's drain.
      if (restorationArmed) {
        if (!(await restoreGatewayService(reason))) process.exitCode = 1;
      } else recordUpdateHandoffOutcome(reason);
      if (!updateCancelled) process.exitCode = 1;
      return;
    }
    const { updaterOutput, outputOverflow } = exit;
    // Only this invocation's direct child result carries the producer decision.
    // Success may change install roots; only recovery requires the original root.
    // Sentinels and diagnostic exports never authorize activation.
    let result = null;
    try { if (!outputOverflow) result = JSON.parse(updaterOutput); } catch {}
    let resultRoot;
    try { resultRoot = fs.realpathSync(result?.root); } catch {}
    if (result?.status === "ok" && resultRoot && resultRoot !== params.updateLeaseKey) {
      terminalRuntimePath = path.join(resultRoot, "dist", "cli", "daemon-cli.js");
    }
    const reportedFailure = isFailedUpdateOutcome(result?.status, result?.reason);
    if (!exit.signal && exit.code === 0 && resultRoot && result?.status === "ok") {
      runOutcome = { status: "succeeded", after: result.after };
    } else if (resultRoot && ["error", "skipped"].includes(result?.status)) {
      runOutcome = { status: result.status === "error" ? "failed" : "skipped", reason: result.reason, after: result.after };
    }
    if (reportedFailure) triageFailure ??= { reason: result?.reason || "managed-service-handoff-failed" };
    const childStatus = !exit.signal && resultRoot === params.updateLeaseKey && ["error", "skipped"].includes(result?.status) ? result.status : undefined;
    const recovery = childStatus ? result.recovery : null;
    const safe = !exit.signal && recovery?.serviceRestartSafe === true &&
      typeof recovery.version === "string" && recovery.version.trim() &&
      (recovery.buildId === undefined ? result.mode !== "git" :
        typeof recovery.buildId === "string" && recovery.buildId.trim() && recovery.buildId.length <= 96) &&
      ownsManagedUpdateLease();
    const recoveryRun = safe && recovery.packageRollbackVerified === true && runLedger?.getUpdateRun(params.runId);
    // The rollback owner restores the generation and grants restart authority. The
    // same-run receipt corroborates it; exit 79 alone never permits a recovery start.
    const previousGeneration = restorationArmed && recoveryRun?.status === "running" &&
      recoveryRun.runId === params.runId && recoveryRun.before.version === recovery.version &&
      recoveryRun.after.version === recovery.version && result.before?.version === recovery.version &&
      result.after?.version === recovery.version && (!recovery.buildId ||
        [recoveryRun.before, recoveryRun.after, result.before, result.after].every((version) => version.buildId === recovery.buildId)) && recoveryRun.steps.some((step) =>
        step.step === "previous generation restoration" && step.status === "completed");
    if (exit.code === ${MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE} && !previousGeneration) {
      appendLog("managed update reported unsafe recovery; keep the gateway stopped until the installation is repaired and update succeeds");
      recordUpdateHandoffOutcome("managed-service-handoff-unsafe-recovery");
      process.exitCode = exit.code;
    } else if (!resultRoot || result?.status !== "ok" ||
      exit.signal || exit.code !== 0) {
      let restored = !restorationArmed || (safe && recovery.service === "healthy");
      if (restorationArmed && safe && recovery.service === undefined) {
        restored = await restoreGatewayService(previousGeneration ? result.reason : "managed-service-handoff-failed", recovery, childStatus, previousGeneration);
      } else {
        if (restored && triageFailure) triageFailure.restored = true;
        appendLog("managed update recovery not attempted: " +
          (recovery?.serviceRestartSafe === false ? "updater explicitly rejected activation" :
            recovery?.service === "healthy" ? "updater already verified recovery" :
              recovery?.service === "failed" ? "updater recovery failed; no automatic retry" :
                "no verified recovery result; inspect the installation before restarting"));
        if (childStatus !== "skipped" || !restored) {
          recordUpdateHandoffOutcome("managed-service-handoff-failed", undefined, childStatus === "skipped" ? "error" : childStatus);
        }
      }
      if (previousGeneration && restored) {
        runOutcome = { status: "rolled-back", reason: result.reason, after: result.after };
      }
      process.exitCode = previousGeneration && restored ? 1 : exit.code ||
        (childStatus === "skipped" && restored && !exit.signal && !reportedFailure ? 0 : 1);
    }
  } catch (err) {
    appendLog("handoff failed: " + (err && err.stack ? err.stack : String(err)));
    const reason = err?.code === "owner_required" ? "owner_required" : "managed-service-handoff-helper-failed";
    runOutcome = { status: "failed", reason };
    if (managedUpdateLeaseOwned) {
      bindManagedUpdateLeaseToProcess(process.pid);
      if (restorationArmed && !updaterStarted) await restoreGatewayService(reason);
      else recordUpdateHandoffOutcome(reason);
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(parentExitDeadline);
    if (runLedger && runOutcome) {
      try {
        const terminalResult = { ...runOutcome, ...(serviceDowntimeMs !== undefined ? { downtimeMs: serviceDowntimeMs } : {}) };
        if (!updaterStarted) runLedger.finishUpdateRun(params.runId, terminalResult);
        else {
          // Doctor may have advanced the schema. A new process loads the candidate's
          // entire module graph; a cache-busted import would retain old DB readers.
          const payload = JSON.stringify([terminalRuntimePath, params.runId, terminalResult]);
          if (Buffer.byteLength(payload) > 64 * 1024) throw new Error("managed update terminal result exceeds the command payload limit");
          const exit = await runOwnedUpdateCommand("finalize", [process.execPath, "--input-type=module", "-e",
            'import { pathToFileURL } from "node:url"; const [modulePath, runId, result] = JSON.parse(process.argv[1]); const { finishUpdateRun } = await import(pathToFileURL(modulePath).href); finishUpdateRun(runId, result);',
            payload], Math.min(params.recoveryTimeoutMs, 60_000));
          if (exit.signal || exit.code !== 0) throw new Error("installed runtime could not finalize the update run");
        }
      }
      catch (error) {
        appendLog("failed to finalize update run: " + String(error));
        process.exitCode = 1;
      }
    }
    // Recovery owns availability. Diagnostics run once only after its terminal
    // outcome, while this helper still owns the installation lease.
    await collectUpdateFailureTriage();
    releaseManagedUpdateLease();
    process.stdin.destroy();
    cleanupSensitiveFiles();
    appendLog("managed update helper completed code=" + (process.exitCode || 0));
  }
})().catch((err) => {
  appendLog("handoff setup failed: " + (err && err.stack ? err.stack : String(err)));
  cleanupSensitiveFiles();
  process.exitCode = 1;
});
`;

type ManagedServiceUpdateHandoffParams = {
  runId?: string;
  beforePark?: () => Promise<void>;
  root: string;
  timeoutMs?: number;
  restartDrainTimeoutMs: number;
  restartDelayMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  acceptCapabilities?: boolean;
  meta: UpdateRestartSentinelMeta;
  requester?: { channel?: string; accountId?: string; senderId?: string };
  handoffId?: string;
  supervisor?: RespawnSupervisor | null;
  env?: NodeJS.ProcessEnv;
  devTarget?: DevUpdateTarget;
  execPath?: string;
  argv1?: string;
  parentPid?: number;
  invocationCwd?: string;
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
  beforePark?: () => Promise<void>;
  flight?: Promise<ManagedServiceUpdateHandoffResult>;
  launcher?: HandoffChild;
  launcherStartIdentity?: number | null;
  helper?: { owner: string; pid: number; startIdentity: string };
  claimed?: boolean;
  transferred?: boolean;
  cancelling?: boolean;
  exited?: boolean;
};
const activeManagedServiceUpdateHandoffs = new Map<string, ActiveManagedServiceUpdateHandoff>();

function resolveUpdateCliArgv(params: {
  timeoutMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  acceptCapabilities?: boolean;
  execPath?: string;
  argv1?: string;
}): string[] {
  const updateArgs = ["update", "--yes", "--json"];
  if (params.acceptCapabilities) {
    updateArgs.push("--accept-capabilities");
  }
  if (params.channel) {
    updateArgs.push("--channel", params.channel);
  }
  if (params.tag) {
    updateArgs.push("--tag", params.tag);
  }
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    updateArgs.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000))));
  }

  return resolveManagedServiceCliArgv(params, updateArgs);
}

function resolveManagedServiceCliArgv(
  params: { execPath?: string; argv1?: string },
  args: string[],
): string[] {
  const execPath = params.execPath?.trim();
  const argv1 = params.argv1?.trim();
  if (execPath && argv1) {
    return [execPath, argv1, ...args];
  }
  if (execPath && !/^(?:node|bun)(?:\.exe)?$/iu.test(path.basename(execPath))) {
    return [execPath, ...args];
  }
  return ["openclaw", ...args];
}

export function formatManagedServiceUpdateCommand(
  params?: {
    timeoutMs?: number;
    channel?: UpdateChannel;
    tag?: string;
    acceptCapabilities?: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  return formatCliCommand(
    resolveUpdateCliArgv(params ?? {})
      .toSpliced(3, 1)
      .join(" "),
    env,
  );
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
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline + 1);
        buffered = buffered.slice(newline + 1);
        if (line !== HANDOFF_NOTICE_MARKER) {
          finish(line.slice(0, -1));
          return;
        }
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
  const triageInputPath = path.join(dir, "update-failure.json");
  const serviceEnv = params.env ?? process.env;
  const installationTarget = resolveInstallationTarget(serviceEnv);
  const triageContextPath = path.join(
    installationTarget.stateDir,
    "logs",
    "support",
    `openclaw-update-failure-${randomUUID()}.json`,
  );
  const logPath = path.join(dir, "handoff.log");
  const commandArgv = resolveUpdateCliArgv({
    ...params,
    execPath: params.execPath ?? process.execPath,
    argv1: params.argv1 ?? process.argv[1],
  });
  const commandLabel = formatManagedServiceUpdateCommand(
    {
      timeoutMs: params.timeoutMs,
      channel: params.channel,
      tag: params.tag,
      acceptCapabilities: params.acceptCapabilities,
    },
    params.env,
  );
  const metaFile: ControlPlaneUpdateSentinelMetaFile = {
    version: 1,
    meta: {
      ...params.meta,
      ...(params.runId ? { runId: params.runId } : {}),
      root: rootIdentity,
      triageContextPath,
    },
  };
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
    Math.max(0, params.restartDrainTimeoutMs) + PARENT_EXIT_SHUTDOWN_RESERVE_MS,
  );
  const helperParams = {
    runId: metaFile.meta.runId,
    beforePark: Boolean(params.beforePark),
    requester: resolveManagedUpdateRequester(params.requester),
    parentPid,
    parentStartIdentity: String(parentStartIdentity),
    parentExitTimeoutMs,
    restartDelayMs: Math.max(0, Math.min(60_000, params.restartDelayMs ?? 0)),
    parentExitDeadlineAt: Date.now() + parentExitTimeoutMs,
    cwd: dir,
    invocationCwd: params.invocationCwd,
    commandArgv,
    recoveryCommandArgv: resolveManagedServiceCliArgv(
      { execPath: params.execPath ?? process.execPath, argv1: params.argv1 ?? process.argv[1] },
      ["gateway", "restart", "--preserve-definition", "--json"],
    ),
    recoveryTimeoutMs: params.timeoutMs ?? 30 * 60_000,
    triageCommandArgv: resolveManagedServiceCliArgv(
      { execPath: params.execPath ?? process.execPath, argv1: params.argv1 ?? process.argv[1] },
      ["triage", "--json", "--non-interactive"],
    ),
    triageContextPath,
    triageInputPath,
    triageContextCommand: formatInstallationTargetCommand(
      ["openclaw", "triage", "--update-result", triageContextPath],
      installationTarget,
      { env: serviceEnv },
    ),
    triageRecoveryCommand: formatInstallationTargetCommand(
      ["openclaw", "triage"],
      installationTarget,
      { env: serviceEnv },
    ),
    // This hint becomes a model/channel notice; host paths remain in the helper log.
    triageHint:
      "Update triage runs after service recovery; see the managed update helper log for the outcome and the installation-specific openclaw triage command.",
    commandLabel,
    handoffId: params.handoffId,
    nonFailureSkippedReasons: Object.keys(SKIPPED_UPDATE_OUTCOMES),
    logPath,
    metaPath,
    stateDatabasePath,
    nodeSqliteLocation: resolveNodeSqliteLocation(stateDatabasePath),
    updateLeaseDatabasePath: resolveManagedUpdateLeaseDatabasePath(),
    updateLeaseKey: rootIdentity,
    updateLeaseOwner: params.handoffId,
    sensitivePaths: [scriptPath, paramsPath, metaPath, triageInputPath],
    serviceRecovery: resolveGatewayServiceRecovery(params.supervisor, serviceEnv),
    recovery: await ((await looksLikeGitCheckout(rootIdentity))
      ? readCurrentGitUpdateRecovery(rootIdentity)
      : verifyPackageUpdateRecovery(rootIdentity)),
    recoveryModulePath: path.join(rootIdentity, "dist", "cli", "daemon-cli.js"),
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
      ...(metaFile.meta.runId ? { [UPDATE_RUN_ID_ENV]: metaFile.meta.runId } : {}),
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
  if (params.beforePark) {
    let buffered = "";
    const isCurrent = () =>
      activeManagedServiceUpdateHandoffs.get(rootIdentity) === owner &&
      owner.transferred &&
      !owner.cancelling &&
      !owner.exited;
    const onNotice = (chunk: Buffer | string) => {
      buffered = `${buffered}${chunk.toString()}`.slice(-1024);
      if (!buffered.includes(HANDOFF_NOTICE_MARKER)) {
        return;
      }
      child.stdout.off("data", onNotice);
      if (!isCurrent()) {
        return;
      }
      // The helper's lease now names the validating runner. Its park owner
      // revalidates that lease; this captured pipe only coordinates the notice.
      void owner.beforePark?.().then(
        () => {
          if (isCurrent()) {
            child.stdin.write("noticed\n");
          }
        },
        () => {
          if (isCurrent()) {
            child.stdin.write("notice-failed\n");
          }
        },
      );
    };
    child.stdout.on("data", onNotice);
    child.once("exit", () => child.stdout.off("data", onNotice));
  }

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
  // After a transferred helper exits, durable admission fences any surviving
  // updater. An exited local owner must not pin no-ops or replacement helpers.
  if (
    active?.flight &&
    (!active.exited || active.cancelling || (active.claimed && !active.transferred))
  ) {
    const joined = await active.flight;
    return {
      status: "joined",
      command: joined.command,
      logPath: joined.logPath,
      ...(joined.pid ? { pid: joined.pid } : {}),
      ...(joined.handoffId ? { handoffId: joined.handoffId } : {}),
    };
  }
  const owner: ActiveManagedServiceUpdateHandoff = {
    handoffId: params.handoffId ?? randomUUID(),
    ...(params.beforePark ? { beforePark: params.beforePark } : {}),
  };
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

/** A transferred updater may inspect its serving ancestor only under its current lease. */
export async function isCurrentManagedServiceUpdateHandoffProcess(params: {
  root: string;
  runId: string | undefined;
}): Promise<boolean> {
  if (process.env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1" || !params.runId) {
    return false;
  }
  const meta = await readControlPlaneUpdateSentinelMeta();
  const root = resolveUpdateInstallRoot(params.root);
  if (
    meta?.runId !== params.runId ||
    !meta.handoffId ||
    !meta.root ||
    resolveUpdateInstallRoot(meta.root) !== root
  ) {
    return false;
  }
  const lease = readManagedServiceUpdateHandoffLease(root);
  const startIdentity = getFileLockProcessStartTime(process.pid);
  return (
    lease?.owner === meta.handoffId &&
    lease.pid === process.pid &&
    startIdentity !== null &&
    lease.startIdentity === String(startIdentity)
  );
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
  if (!claimManagedServiceUpdateHandoff(identity)) {
    return false;
  }
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const owner = activeManagedServiceUpdateHandoffs.get(root);
  await owner?.beforePark?.();
  // A notice can await transport recovery. Only the same live helper may
  // receive park after that await; a replacement never inherits this effect.
  if (
    activeManagedServiceUpdateHandoffs.get(root) !== owner ||
    !claimManagedServiceUpdateHandoff(identity)
  ) {
    return false;
  }
  return (
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

export async function transferManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<boolean> {
  const active = activeManagedServiceUpdateHandoffs.get(
    resolveUpdateInstallRoot(identity.installRoot),
  );
  const child = active?.launcher;
  if (
    !active ||
    !(child?.stdin instanceof Socket) ||
    !(child.stdout instanceof Socket) ||
    !claimManagedServiceUpdateHandoff(identity)
  ) {
    return false;
  }
  active.transferred = true;
  if ((await sendManagedServiceUpdateHandoffCommand(identity, "transfer")) !== "transferred") {
    active.transferred = false;
    return false;
  }
  // The acknowledged helper may already have bound its lease to the validating
  // child. Only acknowledged transfer releases the child and its control pipes;
  // readiness still owns cancellation through native exit.
  child.unref();
  child.stdin.unref();
  child.stdout.unref();
  return true;
}

/** Internal helper/orchestrator pipe protocol; standalone updates own their service stop. */
export async function activateManagedServiceUpdateHandoff(): Promise<boolean> {
  if (process.env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1") {
    return false;
  }
  await new Promise<void>((resolve, reject) => {
    let buffered = "";
    const cleanup = () => {
      process.stdin.off("data", onData).off("end", onEnd).off("error", onError);
      process.stdin.pause();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => onError(new Error("managed update activation control closed"));
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      if (!buffered.includes("\n") && buffered.length < 64) {
        return;
      }
      cleanup();
      if (buffered === "parked\n") {
        resolve();
      } else {
        reject(new Error("managed update activation was not confirmed"));
      }
    };
    process.stdin.on("data", onData).once("end", onEnd).once("error", onError);
    process.stdout.write(HANDOFF_ACTIVATION_MARKER, (error) => {
      if (error) {
        onError(error);
      }
    });
  });
  return true;
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
    `Stop the foreground Gateway, run \`${command}\` from a shell, then launch the Gateway again. For a managed deployment, use its host's stop, update, and restart workflow.`,
  ].join("\n");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
