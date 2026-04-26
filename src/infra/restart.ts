import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../daemon/constants.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import type { RestartAttempt } from "./restart.types.js";
import { relaunchGatewayScheduledTask } from "./windows-task-restart.js";

export type { RestartAttempt } from "./restart.types.js";

const SPAWN_TIMEOUT_MS = 2000;
const SIGUSR1_AUTH_GRACE_MS = 5000;
const DEFAULT_DEFERRAL_POLL_MS = 500;
const DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS = 30_000;
const RESTART_COOLDOWN_MS = 30_000;
const LAUNCHCTL_ALREADY_LOADED_EXIT_CODE = 37;
const GATEWAY_RESTART_INTENT_FILENAME = "gateway-restart-intent.json";
const GATEWAY_RESTART_INTENT_TTL_MS = 60_000;
const GATEWAY_RESTART_INTENT_MAX_BYTES = 1024;

const restartLog = createSubsystemLogger("restart");

export { findGatewayPidsOnPortSync };

let sigusr1AuthorizedCount = 0;
let sigusr1AuthorizedUntil = 0;
let sigusr1ExternalAllowed = false;
let preRestartCheck: (() => number) | null = null;
let restartCycleToken = 0;
let emittedRestartToken = 0;
let consumedRestartToken = 0;
let lastRestartEmittedAt = 0;
let pendingRestartTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRestartDueAt = 0;
let pendingRestartReason: string | undefined;
let pendingRestartEmitHooks: RestartEmitHooks | undefined;
let pendingRestartPreparing = false;
const activeDeferralPolls = new Set<ReturnType<typeof setInterval>>();

function hasUnconsumedRestartSignal(): boolean {
  return emittedRestartToken > consumedRestartToken;
}

function clearPendingScheduledRestart(): void {
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
  }
  pendingRestartTimer = null;
  pendingRestartDueAt = 0;
  pendingRestartReason = undefined;
  pendingRestartEmitHooks = undefined;
  pendingRestartPreparing = false;
}

function clearActiveDeferralPolls(): void {
  for (const poll of activeDeferralPolls) {
    clearInterval(poll);
  }
  activeDeferralPolls.clear();
}

export type RestartAuditInfo = {
  actor?: string;
  deviceId?: string;
  clientIp?: string;
  changedPaths?: string[];
};

type GatewayRestartIntentPayload = {
  kind: "gateway-restart";
  pid: number;
  createdAt: number;
};

function resolveGatewayRestartIntentPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), GATEWAY_RESTART_INTENT_FILENAME);
}

function unlinkGatewayRestartIntentFileSync(intentPath: string): boolean {
  try {
    const stat = fs.lstatSync(intentPath);
    if (!stat.isFile() || stat.nlink > 1) {
      return false;
    }
    fs.unlinkSync(intentPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeRestartIntentPid(pid: number | undefined): number | null {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function writeGatewayRestartIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
}): boolean {
  const targetPid = normalizeRestartIntentPid(opts.targetPid);
  if (targetPid === null) {
    return false;
  }
  const env = opts.env ?? process.env;
  let tmpPath: string | undefined;
  try {
    const intentPath = resolveGatewayRestartIntentPath(env);
    fs.mkdirSync(path.dirname(intentPath), { recursive: true });
    const payload: GatewayRestartIntentPayload = {
      kind: "gateway-restart",
      pid: targetPid,
      createdAt: Date.now(),
    };
    tmpPath = path.join(
      path.dirname(intentPath),
      `.${path.basename(intentPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmpPath, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
    fs.renameSync(tmpPath, intentPath);
    return true;
  } catch (err) {
    if (tmpPath) {
      unlinkGatewayRestartIntentFileSync(tmpPath);
    }
    restartLog.warn(`failed to write gateway restart intent: ${String(err)}`);
    return false;
  }
}

export function clearGatewayRestartIntentSync(env: NodeJS.ProcessEnv = process.env): void {
  unlinkGatewayRestartIntentFileSync(resolveGatewayRestartIntentPath(env));
}

function parseGatewayRestartIntent(raw: string): GatewayRestartIntentPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<GatewayRestartIntentPayload>;
    if (
      parsed.kind === "gateway-restart" &&
      typeof parsed.pid === "number" &&
      Number.isFinite(parsed.pid) &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return parsed as GatewayRestartIntentPayload;
    }
  } catch {
    return null;
  }
  return null;
}

export function consumeGatewayRestartIntentSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  const intentPath = resolveGatewayRestartIntentPath(env);
  let raw: string;
  try {
    const stat = fs.lstatSync(intentPath);
    if (!stat.isFile() || stat.size > GATEWAY_RESTART_INTENT_MAX_BYTES) {
      return false;
    }
    raw = fs.readFileSync(intentPath, "utf8");
  } catch {
    return false;
  } finally {
    clearGatewayRestartIntentSync(env);
  }
  const payload = parseGatewayRestartIntent(raw);
  if (!payload) {
    return false;
  }
  if (payload.pid !== process.pid) {
    return false;
  }
  const ageMs = now - payload.createdAt;
  return ageMs >= 0 && ageMs <= GATEWAY_RESTART_INTENT_TTL_MS;
}

function summarizeChangedPaths(paths: string[] | undefined, maxPaths = 6): string | null {
  if (!Array.isArray(paths) || paths.length === 0) {
    return null;
  }
  if (paths.length <= maxPaths) {
    return paths.join(",");
  }
  const head = paths.slice(0, maxPaths).join(",");
  return `${head},+${paths.length - maxPaths} more`;
}

function formatRestartAudit(audit: RestartAuditInfo | undefined): string {
  const actor = typeof audit?.actor === "string" && audit.actor.trim() ? audit.actor.trim() : null;
  const deviceId =
    typeof audit?.deviceId === "string" && audit.deviceId.trim() ? audit.deviceId.trim() : null;
  const clientIp =
    typeof audit?.clientIp === "string" && audit.clientIp.trim() ? audit.clientIp.trim() : null;
  const changed = summarizeChangedPaths(audit?.changedPaths);
  const fields = [];
  if (actor) {
    fields.push(`actor=${actor}`);
  }
  if (deviceId) {
    fields.push(`device=${deviceId}`);
  }
  if (clientIp) {
    fields.push(`ip=${clientIp}`);
  }
  if (changed) {
    fields.push(`changedPaths=${changed}`);
  }
  return fields.length > 0 ? fields.join(" ") : "actor=<unknown>";
}

/**
 * Register a callback that scheduleGatewaySigusr1Restart checks before emitting SIGUSR1.
 * The callback should return the number of pending items (0 = safe to restart).
 */
export function setPreRestartDeferralCheck(fn: () => number): void {
  preRestartCheck = fn;
}

/**
 * Emit an authorized SIGUSR1 gateway restart, guarded against duplicate emissions.
 * Returns true if SIGUSR1 was emitted, false if a restart was already emitted.
 * Both scheduleGatewaySigusr1Restart and the config watcher should use this
 * to ensure only one restart fires.
 */
export function emitGatewayRestart(): boolean {
  if (hasUnconsumedRestartSignal()) {
    clearActiveDeferralPolls();
    clearPendingScheduledRestart();
    return false;
  }
  clearActiveDeferralPolls();
  clearPendingScheduledRestart();
  const cycleToken = ++restartCycleToken;
  emittedRestartToken = cycleToken;
  authorizeGatewaySigusr1Restart();
  try {
    if (process.listenerCount("SIGUSR1") > 0) {
      process.emit("SIGUSR1");
    } else {
      process.kill(process.pid, "SIGUSR1");
    }
  } catch {
    // Roll back the cycle marker so future restart requests can still proceed.
    emittedRestartToken = consumedRestartToken;
    return false;
  }
  lastRestartEmittedAt = Date.now();
  return true;
}

function resetSigusr1AuthorizationIfExpired(now = Date.now()) {
  if (sigusr1AuthorizedCount <= 0) {
    return;
  }
  if (now <= sigusr1AuthorizedUntil) {
    return;
  }
  sigusr1AuthorizedCount = 0;
  sigusr1AuthorizedUntil = 0;
}

export function setGatewaySigusr1RestartPolicy(opts?: { allowExternal?: boolean }) {
  sigusr1ExternalAllowed = opts?.allowExternal === true;
}

export function isGatewaySigusr1RestartExternallyAllowed() {
  return sigusr1ExternalAllowed;
}

function authorizeGatewaySigusr1Restart(delayMs = 0) {
  const delay = Math.max(0, Math.floor(delayMs));
  const expiresAt = Date.now() + delay + SIGUSR1_AUTH_GRACE_MS;
  sigusr1AuthorizedCount += 1;
  if (expiresAt > sigusr1AuthorizedUntil) {
    sigusr1AuthorizedUntil = expiresAt;
  }
}

export function consumeGatewaySigusr1RestartAuthorization(): boolean {
  resetSigusr1AuthorizationIfExpired();
  if (sigusr1AuthorizedCount <= 0) {
    return false;
  }
  sigusr1AuthorizedCount -= 1;
  if (sigusr1AuthorizedCount <= 0) {
    sigusr1AuthorizedUntil = 0;
  }
  return true;
}

/**
 * Mark the currently emitted SIGUSR1 restart cycle as consumed by the run loop.
 * This explicitly advances the cycle state instead of resetting emit guards inside
 * consumeGatewaySigusr1RestartAuthorization().
 */
export function markGatewaySigusr1RestartHandled(): void {
  if (hasUnconsumedRestartSignal()) {
    consumedRestartToken = emittedRestartToken;
  }
}

export type RestartDeferralHooks = {
  onDeferring?: (pending: number) => void;
  onStillPending?: (pending: number, elapsedMs: number) => void;
  onReady?: () => void;
  onTimeout?: (pending: number, elapsedMs: number) => void;
  onCheckError?: (err: unknown) => void;
};

export type RestartEmitHooks = {
  beforeEmit?: () => Promise<void>;
  afterEmitRejected?: () => Promise<void>;
};

function updatePendingRestartEmitHooks(hooks?: RestartEmitHooks): void {
  if (hooks) {
    pendingRestartEmitHooks = hooks;
  }
}

async function emitPreparedGatewayRestart(hooks?: RestartEmitHooks): Promise<void> {
  let nextHooks = hooks ?? pendingRestartEmitHooks;
  if (!hooks) {
    pendingRestartEmitHooks = undefined;
  }
  let preparedHooks: RestartEmitHooks | undefined;
  while (nextHooks) {
    if (preparedHooks) {
      await preparedHooks.afterEmitRejected?.().catch(() => undefined);
      preparedHooks = undefined;
    }
    try {
      await nextHooks.beforeEmit?.();
      preparedHooks = nextHooks;
    } catch (err) {
      restartLog.warn(
        `restart preparation failed; restart will continue without it: ${String(err)}`,
      );
    }
    if (hooks) {
      break;
    }
    nextHooks = pendingRestartEmitHooks;
    pendingRestartEmitHooks = undefined;
  }

  const emitted = emitGatewayRestart();
  if (!emitted) {
    await preparedHooks?.afterEmitRejected?.().catch(() => undefined);
  }
}

/**
 * Poll pending work until it drains, then emit one restart signal.
 * A positive maxWaitMs keeps the old capped behavior for explicit configs.
 * Shared by both the direct RPC restart path and the config watcher path.
 */
export function deferGatewayRestartUntilIdle(opts: {
  getPendingCount: () => number;
  hooks?: RestartDeferralHooks;
  emitHooks?: RestartEmitHooks;
  pollMs?: number;
  maxWaitMs?: number;
}): void {
  const pollMsRaw = opts.pollMs ?? DEFAULT_DEFERRAL_POLL_MS;
  const pollMs = Math.max(10, Math.floor(pollMsRaw));
  const maxWaitMs =
    typeof opts.maxWaitMs === "number" && Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs > 0
      ? Math.max(pollMs, Math.floor(opts.maxWaitMs))
      : undefined;

  let pending: number;
  try {
    pending = opts.getPendingCount();
  } catch (err) {
    opts.hooks?.onCheckError?.(err);
    void emitPreparedGatewayRestart(opts.emitHooks);
    return;
  }
  if (pending <= 0) {
    opts.hooks?.onReady?.();
    void emitPreparedGatewayRestart(opts.emitHooks);
    return;
  }

  opts.hooks?.onDeferring?.(pending);
  const startedAt = Date.now();
  let nextStillPendingAt = startedAt + DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS;
  const poll = setInterval(() => {
    let current: number;
    try {
      current = opts.getPendingCount();
    } catch (err) {
      clearInterval(poll);
      activeDeferralPolls.delete(poll);
      opts.hooks?.onCheckError?.(err);
      void emitPreparedGatewayRestart(opts.emitHooks);
      return;
    }
    if (current <= 0) {
      clearInterval(poll);
      activeDeferralPolls.delete(poll);
      opts.hooks?.onReady?.();
      void emitPreparedGatewayRestart(opts.emitHooks);
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    if (Date.now() >= nextStillPendingAt) {
      opts.hooks?.onStillPending?.(current, elapsedMs);
      nextStillPendingAt = Date.now() + DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS;
    }
    if (maxWaitMs !== undefined && elapsedMs >= maxWaitMs) {
      clearInterval(poll);
      activeDeferralPolls.delete(poll);
      opts.hooks?.onTimeout?.(current, elapsedMs);
      void emitPreparedGatewayRestart(opts.emitHooks);
    }
  }, pollMs);
  activeDeferralPolls.add(poll);
}

function formatSpawnDetail(result: {
  error?: unknown;
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}): string {
  const clean = (value: string | Buffer | null | undefined) => {
    const text = typeof value === "string" ? value : value ? value.toString() : "";
    return text.replace(/\s+/g, " ").trim();
  };
  if (result.error) {
    if (result.error instanceof Error) {
      return result.error.message;
    }
    if (typeof result.error === "string") {
      return result.error;
    }
    try {
      return JSON.stringify(result.error);
    } catch {
      return "unknown error";
    }
  }
  const stderr = clean(result.stderr);
  if (stderr) {
    return stderr;
  }
  const stdout = clean(result.stdout);
  if (stdout) {
    return stdout;
  }
  if (typeof result.status === "number") {
    return `exit ${result.status}`;
  }
  return "unknown error";
}

function normalizeSystemdUnit(raw?: string, profile?: string): string {
  const unit = raw?.trim();
  if (!unit) {
    return `${resolveGatewaySystemdServiceName(profile)}.service`;
  }
  return unit.endsWith(".service") ? unit : `${unit}.service`;
}

export function triggerOpenClawRestart(): RestartAttempt {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return { ok: true, method: "supervisor", detail: "test mode" };
  }

  cleanStaleGatewayProcessesSync();

  const tried: string[] = [];
  if (process.platform === "linux") {
    const unit = normalizeSystemdUnit(
      process.env.OPENCLAW_SYSTEMD_UNIT,
      process.env.OPENCLAW_PROFILE,
    );
    const userArgs = ["--user", "restart", unit];
    tried.push(`systemctl ${userArgs.join(" ")}`);
    const userRestart = spawnSync("systemctl", userArgs, {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });
    if (!userRestart.error && userRestart.status === 0) {
      return { ok: true, method: "systemd", tried };
    }
    const systemArgs = ["restart", unit];
    tried.push(`systemctl ${systemArgs.join(" ")}`);
    const systemRestart = spawnSync("systemctl", systemArgs, {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });
    if (!systemRestart.error && systemRestart.status === 0) {
      return { ok: true, method: "systemd", tried };
    }
    const detail = [
      `user: ${formatSpawnDetail(userRestart)}`,
      `system: ${formatSpawnDetail(systemRestart)}`,
    ].join("; ");
    return { ok: false, method: "systemd", detail, tried };
  }

  if (process.platform === "win32") {
    return relaunchGatewayScheduledTask(process.env);
  }

  if (process.platform !== "darwin") {
    return {
      ok: false,
      method: "supervisor",
      detail: "unsupported platform restart",
    };
  }

  const label =
    process.env.OPENCLAW_LAUNCHD_LABEL ||
    resolveGatewayLaunchAgentLabel(process.env.OPENCLAW_PROFILE);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const domain = uid !== undefined ? `gui/${uid}` : "gui/501";
  const target = `${domain}/${label}`;
  const args = ["kickstart", "-k", target];
  tried.push(`launchctl ${args.join(" ")}`);
  const res = spawnSync("launchctl", args, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (!res.error && res.status === 0) {
    return { ok: true, method: "launchctl", tried };
  }

  // kickstart fails when the service was previously booted out (deregistered from launchd).
  // Fall back to bootstrap (re-register from plist) + kickstart.
  // Use env HOME to match how launchd.ts resolves the plist install path.
  const home = process.env.HOME?.trim() || os.homedir();
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const bootstrapArgs = ["bootstrap", domain, plistPath];
  tried.push(`launchctl ${bootstrapArgs.join(" ")}`);
  const boot = spawnSync("launchctl", bootstrapArgs, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (
    boot.error ||
    (boot.status !== 0 &&
      boot.status !== LAUNCHCTL_ALREADY_LOADED_EXIT_CODE &&
      boot.status !== null)
  ) {
    return {
      ok: false,
      method: "launchctl",
      detail: formatSpawnDetail(boot),
      tried,
    };
  }
  const retryArgs = ["kickstart", target];
  tried.push(`launchctl ${retryArgs.join(" ")}`);
  const retry = spawnSync("launchctl", retryArgs, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (!retry.error && retry.status === 0) {
    return { ok: true, method: "launchctl", tried };
  }
  return {
    ok: false,
    method: "launchctl",
    detail: formatSpawnDetail(retry),
    tried,
  };
}

export type ScheduledRestart = {
  ok: boolean;
  pid: number;
  signal: "SIGUSR1";
  delayMs: number;
  reason?: string;
  mode: "emit" | "signal";
  coalesced: boolean;
  cooldownMsApplied: number;
};

export function scheduleGatewaySigusr1Restart(opts?: {
  delayMs?: number;
  reason?: string;
  audit?: RestartAuditInfo;
  emitHooks?: RestartEmitHooks;
}): ScheduledRestart {
  const delayMsRaw =
    typeof opts?.delayMs === "number" && Number.isFinite(opts.delayMs)
      ? Math.floor(opts.delayMs)
      : 2000;
  const delayMs = Math.min(Math.max(delayMsRaw, 0), 60_000);
  const reason =
    typeof opts?.reason === "string" && opts.reason.trim()
      ? opts.reason.trim().slice(0, 200)
      : undefined;
  const mode = process.listenerCount("SIGUSR1") > 0 ? "emit" : "signal";
  const nowMs = Date.now();
  const cooldownMsApplied = Math.max(0, lastRestartEmittedAt + RESTART_COOLDOWN_MS - nowMs);
  const requestedDueAt = nowMs + delayMs + cooldownMsApplied;

  if (hasUnconsumedRestartSignal()) {
    restartLog.warn(
      `restart request coalesced (already in-flight) reason=${reason ?? "unspecified"} ${formatRestartAudit(opts?.audit)}`,
    );
    return {
      ok: true,
      pid: process.pid,
      signal: "SIGUSR1",
      delayMs: 0,
      reason,
      mode,
      coalesced: true,
      cooldownMsApplied,
    };
  }

  if (pendingRestartTimer || pendingRestartPreparing) {
    const remainingMs = pendingRestartPreparing ? 0 : Math.max(0, pendingRestartDueAt - nowMs);
    const shouldPullEarlier = !pendingRestartPreparing && requestedDueAt < pendingRestartDueAt;
    if (shouldPullEarlier) {
      restartLog.warn(
        `restart request rescheduled earlier reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} oldDelayMs=${remainingMs} newDelayMs=${Math.max(0, requestedDueAt - nowMs)} ${formatRestartAudit(opts?.audit)}`,
      );
      clearPendingScheduledRestart();
    } else {
      restartLog.warn(
        `restart request coalesced (already scheduled) reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} delayMs=${remainingMs} ${formatRestartAudit(opts?.audit)}`,
      );
      updatePendingRestartEmitHooks(opts?.emitHooks);
      return {
        ok: true,
        pid: process.pid,
        signal: "SIGUSR1",
        delayMs: remainingMs,
        reason,
        mode,
        coalesced: true,
        cooldownMsApplied,
      };
    }
  }

  pendingRestartDueAt = requestedDueAt;
  pendingRestartReason = reason;
  pendingRestartEmitHooks = opts?.emitHooks;
  pendingRestartTimer = setTimeout(
    () => {
      pendingRestartTimer = null;
      pendingRestartDueAt = 0;
      pendingRestartReason = undefined;
      pendingRestartPreparing = true;
      const pendingCheck = preRestartCheck;
      if (!pendingCheck) {
        void emitPreparedGatewayRestart();
        return;
      }
      const cfg = getRuntimeConfig();
      deferGatewayRestartUntilIdle({
        getPendingCount: pendingCheck,
        maxWaitMs: cfg.gateway?.reload?.deferralTimeoutMs,
      });
    },
    Math.max(0, requestedDueAt - nowMs),
  );
  return {
    ok: true,
    pid: process.pid,
    signal: "SIGUSR1",
    delayMs: Math.max(0, requestedDueAt - nowMs),
    reason,
    mode,
    coalesced: false,
    cooldownMsApplied,
  };
}

export const __testing = {
  resetSigusr1State() {
    sigusr1AuthorizedCount = 0;
    sigusr1AuthorizedUntil = 0;
    sigusr1ExternalAllowed = false;
    preRestartCheck = null;
    restartCycleToken = 0;
    emittedRestartToken = 0;
    consumedRestartToken = 0;
    lastRestartEmittedAt = 0;
    clearActiveDeferralPolls();
    clearPendingScheduledRestart();
  },
};
