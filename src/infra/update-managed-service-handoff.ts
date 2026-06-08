// Managed-service update handoff starts a detached process that can finish an
// update after the gateway exits under launchd/systemd-style supervisors.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRestartSentinelPath } from "./restart-sentinel.js";
import { SUPERVISOR_HINT_ENV_VARS, type RespawnSupervisor } from "./supervisor-markers.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  type ControlPlaneUpdateSentinelMetaFile,
} from "./update-control-plane-sentinel.js";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "./update-managed-service-handoff-cleanup.js";
import type { UpdateRestartSentinelMeta } from "./update-restart-sentinel-payload.js";

const PARENT_EXIT_GRACE_MS = 60_000;
const SYSTEMD_RUN_CANDIDATE_PATHS = ["/usr/bin/systemd-run", "/bin/systemd-run"] as const;
const SERVICE_IDENTITY_ENV_VARS = new Set<string>([
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const);

const HANDOFF_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
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

function writeJsonFile(filePath, value) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    "." + path.basename(filePath) + "." + process.pid + "." + Date.now() + ".tmp",
  );
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    appendLog("failed to write update sentinel failure: " + (err && err.stack ? err.stack : String(err)));
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort only.
    }
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
  if (!params.sentinelPath) {
    return;
  }
  const current = readJsonFile(params.sentinelPath);
  let payload = current && current.version === 1 ? current.payload : null;
  if (payload && (payload.kind !== "update" || !isPendingUpdatePayload(payload))) {
    return;
  }
  const handoffId = typeof params.handoffId === "string" ? params.handoffId.trim() : "";
  if (payload && handoffId && (!payload.stats || payload.stats.handoffId !== handoffId)) {
    return;
  }
  if (payload) {
    payload = { ...payload, status: "error" };
    delete payload.continuation;
    payload.stats = { ...(payload.stats || {}), reason };
  } else {
    payload = buildFallbackFailurePayload(reason);
  }
  writeJsonFile(params.sentinelPath, { version: 1, payload });
}

(async () => {
  const deadline = Date.now() + params.parentExitTimeoutMs;
  while (isPidAlive(params.parentPid) && Date.now() < deadline) {
    await sleep(250);
  }
  if (isPidAlive(params.parentPid)) {
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
      process.exitCode = exit.code;
    } else if (exit && exit.signal) {
      markUpdateSentinelFailureIfPending("managed-service-handoff-failed");
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
  cleanupSensitiveFiles();
  process.exitCode = 1;
});
`;

export type ManagedServiceUpdateHandoffResult = {
  status: "started";
  pid?: number;
  command: string;
  logPath: string;
};

function isNodeLikeRuntime(execPath: string | undefined): boolean {
  if (!execPath?.trim()) {
    return false;
  }
  const base = path.basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe";
}

function resolveUpdateCliArgv(params: {
  timeoutMs?: number;
  channel?: "stable" | "beta" | "dev";
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
  channel?: "stable" | "beta" | "dev";
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

export function stripSupervisorHintEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

export async function startManagedServiceUpdateHandoff(params: {
  root: string;
  timeoutMs?: number;
  channel?: "stable" | "beta" | "dev";
  restartDelayMs?: number;
  meta: UpdateRestartSentinelMeta;
  handoffId?: string;
  supervisor?: RespawnSupervisor | null;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  argv1?: string;
  parentPid?: number;
}): Promise<ManagedServiceUpdateHandoffResult> {
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
  const helperParams = {
    parentPid: params.parentPid ?? process.pid,
    parentExitTimeoutMs: Math.max(0, params.restartDelayMs ?? 0) + PARENT_EXIT_GRACE_MS,
    cwd: handoffCwd,
    commandArgv,
    commandLabel,
    handoffId: params.handoffId,
    logPath,
    metaPath,
    sentinelPath: resolveRestartSentinelPath(),
    sensitivePaths: [scriptPath, paramsPath, metaPath],
  };

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
  const child = spawn(spawnTarget.command, spawnTarget.args, {
    cwd: handoffCwd,
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return {
    status: "started",
    ...(child.pid ? { pid: child.pid } : {}),
    command: commandLabel,
    logPath,
  };
}

export function buildManagedServiceHandoffUnavailableMessage(command: string): string {
  return [
    "Package updates cannot safely run inside the live gateway process.",
    `Run \`${command}\` from a shell outside the gateway service, or restart/update from the host control plane.`,
  ].join("\n");
}
