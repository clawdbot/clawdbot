// Managed-service update handoff starts a detached process that can finish an
// update after the gateway exits under launchd/systemd-style supervisors.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { forceKillChildProcessTree } from "../process/child-process-tree.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveNodeSqliteLocation } from "./node-sqlite.js";
import { SUPERVISOR_HINT_ENV_VARS, type RespawnSupervisor } from "./supervisor-markers.js";
import type { UpdateChannel } from "./update-channels.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  type ControlPlaneUpdateSentinelMetaFile,
} from "./update-control-plane-sentinel.js";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "./update-managed-service-handoff-cleanup.js";
import type { UpdateRestartSentinelMeta } from "./update-restart-sentinel-payload.js";

// The Gateway may spend its full restart-drain budget before entering the
// bounded shutdown phase. Keep the helper alive through both phases. (#99666)
const PARENT_EXIT_SHUTDOWN_RESERVE_MS = 30_000;
const HANDOFF_READY_TIMEOUT_MS = 30_000;
const HANDOFF_READY_MARKER = "OPENCLAW_UPDATE_HANDOFF_READY\n";
const HANDOFF_STATE_DATABASE_BUSY_TIMEOUT_MS = 5_000;
const SYSTEMD_RUN_CANDIDATE_PATHS = ["/usr/bin/systemd-run", "/bin/systemd-run"] as const;
const SERVICE_IDENTITY_ENV_VARS = new Set<string>([
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const);
type HandoffChild = ChildProcess & { stdout: NonNullable<ChildProcess["stdout"]> };

const HANDOFF_SCRIPT = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

fs.writeSync(1, ${JSON.stringify(HANDOFF_READY_MARKER)});

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
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

function resolveExistingDirectory(candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "string") {
      continue;
    }
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function isPendingUpdatePayload(payload) {
  const reason = payload && payload.stats && payload.stats.reason;
  return (
    payload &&
    payload.kind === "update" &&
    payload.status === "skipped" &&
    (reason === "managed-service-handoff-started" || reason === "restart-health-pending")
  );
}

function openStateDatabase() {
  if (!params.stateDatabasePath || typeof params.stateDatabasePath !== "string") {
    return null;
  }
  try {
    const sqlite = require("node:sqlite");
    fs.mkdirSync(path.dirname(params.stateDatabasePath), { recursive: true, mode: 0o700 });
    const db = new sqlite.DatabaseSync(params.nodeSqliteLocation);
    db.exec("PRAGMA busy_timeout = ${HANDOFF_STATE_DATABASE_BUSY_TIMEOUT_MS};");
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
    ensureGatewayRestartSentinelColumns(db);
    hardenStateDatabaseFiles();
    return db;
  } catch (err) {
    appendLog("failed to open restart sentinel database: " + (err && err.stack ? err.stack : String(err)));
    return null;
  }
}

function tableHasColumn(db, tableName, columnName) {
  try {
    return db.prepare("PRAGMA table_info(" + tableName + ")").all().some((row) => row && row.name === columnName);
  } catch {
    return false;
  }
}

function ensureColumn(db, tableName, columnSql) {
  const columnName = columnSql.trim().split(/\s+/, 1)[0];
  if (!columnName || tableHasColumn(db, tableName, columnName)) {
    return;
  }
  db.exec("ALTER TABLE " + tableName + " ADD COLUMN " + columnSql + ";");
}

function ensureGatewayRestartSentinelColumns(db) {
  ensureColumn(db, "gateway_restart_sentinel", "delivery_channel TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "delivery_to TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "delivery_account_id TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "message TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "continuation_json TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "doctor_hint TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "stats_json TEXT");
}

function hardenStateDatabaseFiles() {
  if (!params.stateDatabasePath || typeof params.stateDatabasePath !== "string") {
    return;
  }
  for (const filePath of [
    params.stateDatabasePath,
    params.stateDatabasePath + "-wal",
    params.stateDatabasePath + "-shm",
  ]) {
    try {
      if (fs.existsSync(filePath)) {
        fs.chmodSync(filePath, 0o600);
      }
    } catch {
      // Best effort only.
    }
  }
}

function parseJsonColumn(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  try {
    return JSON.parse(value);
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

function readRestartSentinelRevisionFloor(db) {
  const row = db
    .prepare("SELECT updated_at_ms FROM gateway_restart_sentinel WHERE sentinel_key = ?")
    .get("revision-floor");
  if (!row) return null;
  if (!Number.isSafeInteger(row.updated_at_ms)) {
    throw new Error("restart sentinel revision floor is outside the safe integer range");
  }
  return row.updated_at_ms;
}

function advanceRestartSentinelRevisionFloor(db, revision) {
  const payloadJson = JSON.stringify({ kind: "restart", status: "skipped", ts: revision });
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
  ).run(revision, payloadJson, revision);
}

function writeRestartSentinelPayload(db, payload, currentRevision) {
  const revisionFloor = readRestartSentinelRevisionFloor(db);
  const updatedAtMs = Math.max(Date.now(), Math.max(currentRevision || 0, revisionFloor || 0) + 1);
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
    advanceRestartSentinelRevisionFloor(db, updatedAtMs);
  }
  return changed;
}

function buildFallbackFailurePayload(reason) {
  const metaFile = params.metaPath ? readJsonFile(params.metaPath) : null;
  const meta = metaFile && metaFile.version === 1 && metaFile.meta ? metaFile.meta : {};
  const payload = {
    kind: "update",
    status: "error",
    ts: Date.now(),
    message: typeof meta.note === "string" ? meta.note : null,
    stats: {
      mode: "unknown",
      ...(typeof meta.handoffId === "string" && meta.handoffId.trim()
        ? { handoffId: meta.handoffId }
        : {}),
      reason,
      steps: [],
      durationMs: 0,
    },
  };
  if (typeof meta.sessionKey === "string" && meta.sessionKey.trim()) {
    payload.sessionKey = meta.sessionKey;
  }
  if (meta.deliveryContext && typeof meta.deliveryContext === "object") {
    payload.deliveryContext = meta.deliveryContext;
  }
  if (typeof meta.threadId === "string" && meta.threadId.trim()) {
    payload.threadId = meta.threadId;
  }
  return payload;
}

function markUpdateSentinelFailureIfPending(reason) {
  const snapshotDb = openStateDatabase();
  if (!snapshotDb) return;
  let snapshot;
  try {
    snapshot = readRestartSentinelRecord(snapshotDb);
  } catch {
    return;
  } finally {
    try {
      snapshotDb.close();
    } catch {}
  }
  const fallbackPayload = snapshot === null ? buildFallbackFailurePayload(reason) : null;

  const db = openStateDatabase();
  if (!db) return;
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    transactionOpen = true;
    const current = readRestartSentinelRecord(db);
    if (
      (snapshot === null && current !== null) ||
      (snapshot !== null &&
        (current === null || current.revision !== snapshot.revision))
    ) {
      db.exec("COMMIT;");
      transactionOpen = false;
      return;
    }

    let payload = current && current.payload;
    if (payload && (payload.kind !== "update" || !isPendingUpdatePayload(payload))) {
      db.exec("COMMIT;");
      transactionOpen = false;
      return;
    }
    const handoffId = typeof params.handoffId === "string" ? params.handoffId.trim() : "";
    if (payload && handoffId && (!payload.stats || payload.stats.handoffId !== handoffId)) {
      db.exec("COMMIT;");
      transactionOpen = false;
      return;
    }
    if (payload) {
      payload = { ...payload, status: "error" };
      delete payload.continuation;
      payload.stats = { ...(payload.stats || {}), reason };
    } else {
      payload = fallbackPayload;
    }
    if (!payload) {
      throw new Error("restart sentinel disappeared before guarded failure write");
    }
    if (!writeRestartSentinelPayload(db, payload, current ? current.revision : null)) {
      throw new Error("restart sentinel changed before guarded failure write");
    }
    db.exec("COMMIT;");
    transactionOpen = false;
  } catch (err) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK;");
      } catch {}
    }
    appendLog("failed to write update sentinel failure: " + (err && err.stack ? err.stack : String(err)));
  } finally {
    hardenStateDatabaseFiles();
    try {
      db.close();
    } catch {}
  }
}

function runServiceCommand(command, args) {
  try {
    const result = spawnSync(command, args, { stdio: "ignore", timeout: 30000 });
    return typeof result.status === "number" ? result.status : 1;
  } catch {
    return 1;
  }
}

function startGatewayServiceBestEffort() {
  const recovery = params.serviceRecovery;
  if (!recovery || typeof recovery !== "object" || !recovery.kind) {
    return;
  }
  let target = "";
  let status = 1;
  if (recovery.kind === "systemd") {
    target = recovery.unit;
    status = runServiceCommand("systemctl", ["--user", "start", recovery.unit]);
  } else if (recovery.kind === "launchd") {
    target = recovery.label;
    const serviceTarget = "gui/" + recovery.uid + "/" + recovery.label;
    status = runServiceCommand("launchctl", ["kickstart", serviceTarget]);
    if (status !== 0) {
      runServiceCommand("launchctl", ["enable", serviceTarget]);
      status = runServiceCommand("launchctl", [
        "bootstrap",
        "gui/" + recovery.uid,
        recovery.plistPath,
      ]);
      if (status !== 0) {
        // Bootstrap can fail when the label is already loaded. Retry start-only
        // so recovery does not bounce a gateway that is already running.
        status = runServiceCommand("launchctl", ["kickstart", serviceTarget]);
      }
    }
  } else if (recovery.kind === "schtasks") {
    target = recovery.taskName;
    status = runServiceCommand("schtasks.exe", ["/Run", "/TN", recovery.taskName]);
  } else {
    return;
  }
  appendLog(
    "gateway service recovery " +
      (status === 0 ? "succeeded" : "failed status=" + status) +
      " target=" +
      target,
  );
}

(async () => {
  const deadline =
    typeof params.parentExitTimeoutMs === "number"
      ? Date.now() + params.parentExitTimeoutMs
      : null;
  while (isPidAlive(params.parentPid) && (deadline === null || Date.now() < deadline)) {
    await sleep(250);
  }
  if (deadline !== null && isPidAlive(params.parentPid)) {
    appendLog("gateway parent pid " + params.parentPid + " did not exit before handoff timeout");
    markUpdateSentinelFailureIfPending("managed-service-handoff-parent-timeout");
    cleanupSensitiveFiles();
    process.exitCode = 1;
    return;
  }

  appendLog("starting managed update command: " + params.commandLabel);
  let outputFd;
  try {
    outputFd = fs.openSync(params.logPath, "a", 0o600);
    const commandCwd =
      resolveExistingDirectory([
        params.cwd,
        os.homedir(),
        os.tmpdir(),
        path.parse(process.execPath).root,
      ]) || params.cwd;
    if (commandCwd !== params.cwd) {
      appendLog("managed update command cwd fallback: " + params.cwd + " -> " + commandCwd);
    }
    const child = spawn(params.commandArgv[0], params.commandArgv.slice(1), {
      cwd: commandCwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
    });
    appendLog("managed update command pid=" + (child.pid || "unknown"));
    const exit = await new Promise((resolve) => {
      child.once("error", (err) => resolve({ error: err }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (exit && exit.error) {
      appendLog("managed update command failed to start: " + (exit.error && exit.error.stack ? exit.error.stack : String(exit.error)));
      markUpdateSentinelFailureIfPending("managed-service-handoff-spawn-failed");
      startGatewayServiceBestEffort();
      process.exitCode = 1;
      return;
    }
    appendLog(
      "managed update command exited code=" +
        (exit && exit.code !== null && exit.code !== undefined ? exit.code : "null") +
        " signal=" +
        (exit && exit.signal ? exit.signal : "null"),
    );
    if (exit && typeof exit.code === "number" && exit.code !== 0) {
      markUpdateSentinelFailureIfPending("managed-service-handoff-failed");
      startGatewayServiceBestEffort();
      process.exitCode = exit.code;
    } else if (exit && exit.signal) {
      markUpdateSentinelFailureIfPending("managed-service-handoff-failed");
      startGatewayServiceBestEffort();
      process.exitCode = 1;
    }
  } finally {
    if (outputFd !== undefined) {
      try {
        fs.closeSync(outputFd);
      } catch {
        // Ignore close failures.
      }
    }
    cleanupSensitiveFiles();
  }
})().catch((err) => {
  appendLog("handoff failed: " + (err && err.stack ? err.stack : String(err)));
  markUpdateSentinelFailureIfPending("managed-service-handoff-helper-failed");
  startGatewayServiceBestEffort();
  cleanupSensitiveFiles();
  process.exitCode = 1;
});
`;

type ManagedServiceUpdateHandoffParams = {
  root: string;
  timeoutMs?: number;
  restartDrainTimeoutMs: number | undefined;
  channel?: UpdateChannel;
  restartDelayMs?: number;
  meta: UpdateRestartSentinelMeta;
  handoffId?: string;
  supervisor?: RespawnSupervisor | null;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  argv1?: string;
  parentPid?: number;
};

type StartedManagedServiceUpdateHandoff = {
  status: "started";
  pid?: number;
  command: string;
  logPath: string;
  handoffId?: string;
};

type ManagedServiceUpdateHandoffResult = Omit<StartedManagedServiceUpdateHandoff, "status"> & {
  status: "started" | "joined";
};

// Keep one helper per Gateway process through its lifetime. Readiness only
// means it loaded its parameters; spawning another helper before it exits races
// update mutation, service recovery, and restart sentinel ownership.
let activeManagedServiceUpdateHandoff: Promise<StartedManagedServiceUpdateHandoff> | null = null;

function isNodeLikeRuntime(execPath: string | undefined): boolean {
  if (!execPath?.trim()) {
    return false;
  }
  const base = path.basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe";
}

function resolveUpdateCliArgv(params: {
  timeoutMs?: number;
  channel?: UpdateChannel;
  execPath?: string;
  argv1?: string;
}): string[] {
  const updateArgs = ["update", "--yes", "--json"];
  if (params.channel) {
    updateArgs.push("--channel", params.channel);
  }
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    updateArgs.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000))));
  }

  const execPath = params.execPath?.trim();
  const argv1 = params.argv1?.trim();
  if (execPath && argv1) {
    return [execPath, argv1, ...updateArgs];
  }
  if (execPath && !isNodeLikeRuntime(execPath)) {
    return [execPath, ...updateArgs];
  }
  return ["openclaw", ...updateArgs];
}

export function formatManagedServiceUpdateCommand(params?: {
  timeoutMs?: number;
  channel?: UpdateChannel;
}): string {
  const args = ["openclaw", "update", "--yes"];
  if (params?.channel) {
    args.push("--channel", params.channel);
  }
  if (typeof params?.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    args.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000))));
  }
  return args.join(" ");
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
    const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
    const unit = override
      ? override.endsWith(".service")
        ? override
        : `${override}.service`
      : `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
    return { kind: "systemd", unit };
  }
  if (supervisor === "launchd") {
    const label =
      env.OPENCLAW_LAUNCHD_LABEL?.trim() || resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    const home = env.HOME?.trim() || os.homedir();
    return {
      kind: "launchd",
      uid,
      label,
      plistPath: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    };
  }
  if (supervisor === "schtasks") {
    const taskName =
      env.OPENCLAW_WINDOWS_TASK_NAME?.trim() || resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
    return { kind: "schtasks", taskName };
  }
  return undefined;
}

function stripSupervisorHintEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    if (SERVICE_IDENTITY_ENV_VARS.has(key)) {
      continue;
    }
    delete next[key];
  }
  return next;
}

async function resolveManagedServiceHandoffCwd(root: string): Promise<string> {
  const candidates = [os.homedir(), os.tmpdir(), path.dirname(process.execPath), root];
  for (const candidate of candidates) {
    if (!candidate.trim()) {
      continue;
    }
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return root;
}

async function resolveExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  fallbackPaths: readonly string[],
): Promise<string | null> {
  const candidates = new Set<string>();
  const pathValue = env.PATH?.trim();
  if (pathValue) {
    for (const dir of pathValue.split(path.delimiter)) {
      if (dir.trim()) {
        candidates.add(path.join(dir, name));
      }
    }
  }
  for (const candidate of fallbackPaths) {
    candidates.add(candidate);
  }

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function sanitizeSystemdUnitFragment(value: string | undefined): string {
  const normalized = value?.trim().replace(/[^A-Za-z0-9_.:@-]+/gu, "-") ?? "";
  return normalized.replace(/^-+|-+$/gu, "").slice(0, 80);
}

function buildSystemdHandoffUnitName(handoffId: string | undefined): string {
  const suffix =
    sanitizeSystemdUnitFragment(handoffId) ||
    sanitizeSystemdUnitFragment(`${process.pid}-${Date.now()}`) ||
    "handoff";
  return `openclaw-update-${suffix}.scope`;
}

async function waitForHandoffReady(child: HandoffChild): Promise<void> {
  const output = child.stdout;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffered = "";
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      output.removeListener("data", onData);
      output.removeListener("error", onOutputError);
      output.destroy();
    };
    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const onError = (err: Error) => finish(err);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `managed update handoff exited before signaling readiness (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    const terminateBeforeFailure = () => {
      if (typeof child.pid !== "number" || child.pid <= 0) {
        return;
      }
      // A helper that loaded its parameters is armed even if its readiness
      // marker is lost. Stop the detached tree before reporting failure.
      forceKillChildProcessTree(child);
    };
    const onOutputError = (err: Error) => {
      terminateBeforeFailure();
      finish(err);
    };
    const onData = (chunk: Buffer | string) => {
      buffered = `${buffered}${chunk.toString()}`.slice(-HANDOFF_READY_MARKER.length * 2);
      if (buffered.includes(HANDOFF_READY_MARKER)) {
        finish();
      }
    };
    const timeout = setTimeout(() => {
      terminateBeforeFailure();
      finish(new Error("managed update handoff did not signal readiness within 30 seconds"));
    }, HANDOFF_READY_TIMEOUT_MS);

    child.once("error", onError);
    child.once("exit", onExit);
    output.once("error", onOutputError);
    output.on("data", onData);
  });
}

async function resolveHandoffSpawn(params: {
  supervisor?: RespawnSupervisor | null;
  env: NodeJS.ProcessEnv;
  execPath: string;
  scriptPath: string;
  paramsPath: string;
  handoffId?: string;
}): Promise<{ command: string; args: string[] }> {
  if (params.supervisor !== "systemd") {
    return {
      command: params.execPath,
      args: [params.scriptPath, params.paramsPath],
    };
  }

  const systemdRunPath = await resolveExecutableOnPath(
    "systemd-run",
    params.env,
    SYSTEMD_RUN_CANDIDATE_PATHS,
  );
  if (!systemdRunPath) {
    throw new Error(
      "systemd-run is required to start the managed update handoff outside openclaw-gateway.service",
    );
  }

  return {
    command: systemdRunPath,
    args: [
      "--user",
      "--scope",
      "--collect",
      `--unit=${buildSystemdHandoffUnitName(params.handoffId)}`,
      params.execPath,
      params.scriptPath,
      params.paramsPath,
    ],
  };
}

async function spawnManagedServiceUpdateHandoff(
  params: ManagedServiceUpdateHandoffParams,
  onExit: () => void,
): Promise<StartedManagedServiceUpdateHandoff> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX));
  const scriptPath = path.join(dir, "handoff.cjs");
  const paramsPath = path.join(dir, "handoff.json");
  const metaPath = path.join(dir, "sentinel-meta.json");
  const logPath = path.join(dir, "handoff.log");
  const commandArgv = resolveUpdateCliArgv({
    timeoutMs: params.timeoutMs,
    channel: params.channel,
    execPath: params.execPath ?? process.execPath,
    argv1: params.argv1 ?? process.argv[1],
  });
  const commandLabel = formatManagedServiceUpdateCommand({
    timeoutMs: params.timeoutMs,
    channel: params.channel,
  });
  const handoffCwd = await resolveManagedServiceHandoffCwd(params.root);
  const metaFile: ControlPlaneUpdateSentinelMetaFile = {
    version: 1,
    meta: params.meta,
  };
  const stateDatabasePath = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  const helperParams = {
    parentPid: params.parentPid ?? process.pid,
    // An undefined drain timeout is the configured indefinite-wait contract.
    parentExitTimeoutMs:
      params.restartDrainTimeoutMs === undefined
        ? null
        : Math.max(0, params.restartDelayMs ?? 0) +
          Math.max(0, params.restartDrainTimeoutMs) +
          PARENT_EXIT_SHUTDOWN_RESERVE_MS,
    cwd: handoffCwd,
    commandArgv,
    commandLabel,
    handoffId: params.handoffId,
    logPath,
    metaPath,
    stateDatabasePath,
    nodeSqliteLocation: resolveNodeSqliteLocation(stateDatabasePath),
    sensitivePaths: [scriptPath, paramsPath, metaPath],
    serviceRecovery: resolveGatewayServiceRecovery(params.supervisor, params.env ?? process.env),
  };

  let child!: HandoffChild;
  try {
    await fs.writeFile(scriptPath, `${HANDOFF_SCRIPT}\n`, { mode: 0o700 });
    await fs.writeFile(paramsPath, `${JSON.stringify(helperParams, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(metaPath, `${JSON.stringify(metaFile, null, 2)}\n`, { mode: 0o600 });

    const env = {
      ...stripSupervisorHintEnv(params.env ?? process.env),
      [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
      OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    };
    const spawnTarget = await resolveHandoffSpawn({
      supervisor: params.supervisor,
      env,
      execPath: params.execPath ?? process.execPath,
      scriptPath,
      paramsPath,
      handoffId: params.handoffId,
    });
    child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd: handoffCwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.once("exit", onExit);
    // systemd-run --scope remains synchronous until the helper exits, so this
    // child's exit owns the full handoff lifetime. Readiness still must wait
    // until the helper loads its params before callers terminate the Gateway.
    await waitForHandoffReady(child);
  } catch (err) {
    child?.removeListener("exit", onExit);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  child.unref();

  return {
    status: "started",
    ...(child.pid ? { pid: child.pid } : {}),
    command: commandLabel,
    logPath,
    ...(params.handoffId ? { handoffId: params.handoffId } : {}),
  };
}

export async function startManagedServiceUpdateHandoff(
  params: ManagedServiceUpdateHandoffParams,
): Promise<ManagedServiceUpdateHandoffResult> {
  const active = activeManagedServiceUpdateHandoff;
  if (active) {
    return { ...(await active), status: "joined" };
  }

  const flight = spawnManagedServiceUpdateHandoff(params, () => {
    if (activeManagedServiceUpdateHandoff === flight) {
      activeManagedServiceUpdateHandoff = null;
    }
  });
  activeManagedServiceUpdateHandoff = flight;
  try {
    return await flight;
  } catch (err) {
    if (activeManagedServiceUpdateHandoff === flight) {
      activeManagedServiceUpdateHandoff = null;
    }
    throw err;
  }
}

export function buildManagedServiceHandoffUnavailableMessage(command: string): string {
  return [
    "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.",
    `Run \`${command}\` from a shell outside the gateway service, or restart/update from the host UI.`,
  ].join("\n");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
