// Coordinates gateway restart requests across supported supervisors.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../daemon/constants.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  beginGatewayRestartSignalAdmission,
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
  type GatewayRestartSignalAdmissionLease,
} from "../process/gateway-work-admission.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import type { RestartAttempt } from "./restart.types.js";
import { relaunchGatewayScheduledTask } from "./windows-task-restart.js";

export type { RestartAttempt } from "./restart.types.js";

const SPAWN_TIMEOUT_MS = 2000;
const SIGUSR1_AUTH_GRACE_MS = 5000;
const DEFAULT_DEFERRAL_POLL_MS = 500;
const DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS = 30_000;
export const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;
const RESTART_COOLDOWN_MS = 30_000;
const LAUNCHCTL_ALREADY_LOADED_EXIT_CODE = 37;
const GATEWAY_RESTART_INTENT_KEY = "gateway-restart";
const GATEWAY_RESTART_INTENT_TTL_MS = 60_000;

const restartLog = createSubsystemLogger("restart");
type GatewayRestartIntentDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_intent">;

export { findGatewayPidsOnPortSync };

let sigusr1AuthorizedCount = 0;
let sigusr1AuthorizedUntil = 0;
let sigusr1ExternalAllowed = false;
let preRestartCheck: (() => number) | null = null;
let restartCycleToken = 0;
let emittedRestartToken = 0;
let consumedRestartToken = 0;
let emittedRestartReason: string | undefined;
let emittedRestartIntent: GatewayRestartIntent | undefined;
let lastRestartEmittedAt = 0;
let pendingRestartTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRestartDueAt = 0;
let pendingRestartReason: string | undefined;
let pendingRestartEmitHooks: RestartEmitHooks | undefined;
let pendingRestartSessionKey: string | undefined;
let pendingRestartSkipDeferral = false;
let pendingRestartPreparing = false;
let pendingRestartSignalAdmission: GatewayRestartSignalAdmissionLease | null = null;
let restartTransientGeneration = 0;
const activeDeferralPolls = new Set<ReturnType<typeof setInterval>>();

function shouldPreferRestartReason(next?: string, current?: string): boolean {
  const isUpdateRestart = (reason?: string) => reason === "update.run" || reason === "update.auto";
  return isUpdateRestart(next) && !isUpdateRestart(current);
}

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
  pendingRestartSessionKey = undefined;
  pendingRestartSkipDeferral = false;
  pendingRestartPreparing = false;
}

function clearPendingRestartSignalAdmission(): boolean {
  const rolledBack = pendingRestartSignalAdmission?.rollback() ?? false;
  pendingRestartSignalAdmission = null;
  return rolledBack;
}

/** Releases a signal fence when the run loop rejects or fails to handle the signal. */
export function rollbackGatewayRestartSignalAdmission(): boolean {
  return clearPendingRestartSignalAdmission();
}

function armPendingRestartTimer(requestedDueAt: number, nowMs: number): void {
  pendingRestartTimer = setTimeout(
    () => {
      const scheduledReason = pendingRestartReason;
      const scheduledSkipDeferral = pendingRestartSkipDeferral;
      pendingRestartTimer = null;
      pendingRestartDueAt = 0;
      pendingRestartReason = undefined;
      pendingRestartSkipDeferral = false;
      pendingRestartPreparing = true;
      const pendingCheck = preRestartCheck;
      if (scheduledSkipDeferral || !pendingCheck) {
        void emitPreparedGatewayRestart(undefined, scheduledReason);
        return;
      }
      const cfg = getRuntimeConfig();
      const deferralTimeoutMs = resolveGatewayRestartDeferralTimeoutMs(
        cfg.gateway?.reload?.deferralTimeoutMs,
      );
      deferGatewayRestartUntilIdle({
        getPendingCount: pendingCheck,
        maxWaitMs: deferralTimeoutMs,
        reason: scheduledReason,
        timeoutIntent: { force: true, ...(scheduledReason ? { reason: scheduledReason } : {}) },
      });
    },
    Math.max(0, requestedDueAt - nowMs),
  );
}

function clearActiveDeferralPolls(): void {
  for (const poll of activeDeferralPolls) {
    clearInterval(poll);
  }
  activeDeferralPolls.clear();
}

export function resetGatewayRestartStateForInProcessRestart(): void {
  clearActiveDeferralPolls();
  clearPendingScheduledRestart();
  clearPendingRestartSignalAdmission();
  // Cancel any in-progress deferred channel reload so it doesn't race with
  // the restart to start the same channel (e.g. telegram double-spawn).
  void import("../gateway/server-reload-handlers.js")
    .then((mod) => {
      mod.abortPendingChannelReloads();
    })
    .catch(() => {
      // Best-effort: the module may not be loaded in minimal/test gateways.
    });
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
  reason?: string;
  force?: boolean;
  waitMs?: number;
};

export type GatewayRestartIntent = {
  reason?: string;
  force?: boolean;
  waitMs?: number;
};

function normalizeRestartIntentPid(pid: number | undefined): number | null {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function writeGatewayRestartIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
  intent?: GatewayRestartIntent;
  reason?: string;
}): boolean {
  const targetPid = normalizeRestartIntentPid(opts.targetPid);
  if (targetPid === null) {
    return false;
  }
  const env = opts.env ?? process.env;
  try {
    const reason = normalizeRestartIntentReason(opts.reason ?? opts.intent?.reason);
    const waitMs =
      typeof opts.intent?.waitMs === "number" &&
      Number.isFinite(opts.intent.waitMs) &&
      opts.intent.waitMs >= 0
        ? Math.floor(opts.intent.waitMs)
        : null;
    const createdAt = Date.now();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .insertInto("gateway_restart_intent")
            .values({
              intent_key: GATEWAY_RESTART_INTENT_KEY,
              kind: "gateway-restart",
              pid: targetPid,
              created_at: createdAt,
              reason: reason ?? null,
              force: opts.intent?.force ? 1 : null,
              wait_ms: waitMs,
              updated_at_ms: createdAt,
            })
            .onConflict((conflict) =>
              conflict.column("intent_key").doUpdateSet({
                kind: (eb) => eb.ref("excluded.kind"),
                pid: (eb) => eb.ref("excluded.pid"),
                created_at: (eb) => eb.ref("excluded.created_at"),
                reason: (eb) => eb.ref("excluded.reason"),
                force: (eb) => eb.ref("excluded.force"),
                wait_ms: (eb) => eb.ref("excluded.wait_ms"),
                updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
              }),
            ),
        );
      },
      { env },
    );
    return true;
  } catch (err) {
    restartLog.warn(`failed to write gateway restart intent: ${String(err)}`);
    return false;
  }
}

export function clearGatewayRestartIntentSync(env: NodeJS.ProcessEnv = process.env): void {
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .deleteFrom("gateway_restart_intent")
            .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
        );
      },
      { env },
    );
  } catch {}
}

function readGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv,
): GatewayRestartIntentPayload | null {
  try {
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
    const parsed = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("gateway_restart_intent")
        .select(["kind", "pid", "created_at", "reason", "force", "wait_ms"])
        .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
    );
    if (
      parsed?.kind === "gateway-restart" &&
      typeof parsed.pid === "number" &&
      Number.isFinite(parsed.pid) &&
      typeof parsed.created_at === "number" &&
      Number.isFinite(parsed.created_at) &&
      (parsed.reason === null || typeof parsed.reason === "string") &&
      (parsed.force === null ||
        (typeof parsed.force === "number" && Number.isFinite(parsed.force))) &&
      (parsed.wait_ms === null ||
        (typeof parsed.wait_ms === "number" &&
          Number.isFinite(parsed.wait_ms) &&
          parsed.wait_ms >= 0))
    ) {
      const reason = normalizeRestartIntentReason(parsed.reason ?? undefined);
      return {
        kind: "gateway-restart",
        pid: parsed.pid,
        createdAt: parsed.created_at,
        ...(reason ? { reason } : {}),
        ...(parsed.force ? { force: true } : {}),
        ...(typeof parsed.wait_ms === "number" ? { waitMs: Math.floor(parsed.wait_ms) } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeRestartIntentReason(reason: string | undefined): string | undefined {
  const normalized = reason?.trim();
  return normalized ? truncateUtf16Safe(normalized, 200) : undefined;
}

export function consumeGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): GatewayRestartIntent | null {
  const payload = readGatewayRestartIntentPayloadSync(env);
  clearGatewayRestartIntentSync(env);
  if (!payload) {
    return null;
  }
  if (payload.pid !== process.pid) {
    return null;
  }
  const ageMs = now - payload.createdAt;
  if (ageMs < 0 || ageMs > GATEWAY_RESTART_INTENT_TTL_MS) {
    return null;
  }
  return {
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.force ? { force: true } : {}),
    ...(typeof payload.waitMs === "number" ? { waitMs: payload.waitMs } : {}),
  };
}

export function consumeGatewayRestartIntentSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  return consumeGatewayRestartIntentPayloadSync(env, now) !== null;
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
 * Runtime callers use emitGatewayRestartWithSignalAdmission so the signal-to-drain
 * handoff stays fenced; this lower-level primitive remains available to tests.
 */
export function emitGatewayRestart(
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
): boolean {
  if (hasUnconsumedRestartSignal()) {
    clearActiveDeferralPolls();
    clearPendingScheduledRestart();
    return false;
  }
  clearActiveDeferralPolls();
  clearPendingScheduledRestart();
  const cycleToken = ++restartCycleToken;
  emittedRestartToken = cycleToken;
  emittedRestartReason = reasonOverride ?? intent?.reason ?? pendingRestartReason;
  emittedRestartIntent = intent;
  authorizeGatewaySigusr1Restart();
  try {
    if (process.listenerCount("SIGUSR1") > 0) {
      // Signal path: let the run-loop's SIGUSR1 handler drive restart.
      // Works on all platforms including Windows when a listener is registered.
      process.emit("SIGUSR1");
    } else if (process.platform === "win32") {
      // On Windows with no SIGUSR1 listener, fall back to task-scheduler handoff.
      // triggerOpenClawRestart() uses schtasks to restart the gateway.
      const result = triggerOpenClawRestart();
      if (!result.ok) {
        // Roll back the cycle marker so future restart requests can still proceed.
        rollBackGatewayRestartEmission();
        restartLog.warn("Windows scheduled task restart failed, token rolled back");
        return false;
      }
      consumeGatewaySigusr1RestartAuthorization();
      markGatewaySigusr1RestartHandled();
    } else {
      // Unix without listener: send signal directly.
      process.kill(process.pid, "SIGUSR1");
    }
  } catch {
    // Roll back the cycle marker so future restart requests can still proceed.
    rollBackGatewayRestartEmission();
    return false;
  }
  lastRestartEmittedAt = Date.now();
  return true;
}

/**
 * Emits while holding the signal-to-drain admission fence.
 *
 * The caller must already own root-work admission. Scheduled restarts use the
 * independent-root wrapper below; config reloads run inside their reload root.
 */
export function emitGatewayRestartWithSignalAdmission(
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
): boolean {
  const signalAdmission = pendingRestartSignalAdmission ?? beginGatewayRestartSignalAdmission();
  pendingRestartSignalAdmission = signalAdmission;
  const hadUnconsumedRestartSignal = hasUnconsumedRestartSignal();
  const emitted = emitGatewayRestart(reasonOverride, intent);
  if (!emitted && !hadUnconsumedRestartSignal) {
    clearPendingRestartSignalAdmission();
  }
  return emitted;
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

export function peekGatewaySigusr1RestartReason(): string | undefined {
  return hasUnconsumedRestartSignal() ? emittedRestartReason : undefined;
}

/**
 * Reads and clears only the in-memory intent for the current emitted SIGUSR1 cycle.
 * The restart reason and cycle token are advanced by markGatewaySigusr1RestartHandled().
 */
export function consumeGatewaySigusr1RestartIntent(): GatewayRestartIntent | null {
  if (!hasUnconsumedRestartSignal()) {
    return null;
  }
  const intent = emittedRestartIntent ?? null;
  emittedRestartIntent = undefined;
  return intent;
}

/**
 * Mark the currently emitted SIGUSR1 restart cycle as consumed by the run loop.
 * This explicitly advances the cycle state instead of resetting emit guards inside
 * consumeGatewaySigusr1RestartAuthorization().
 */
export function markGatewaySigusr1RestartHandled(): void {
  if (hasUnconsumedRestartSignal()) {
    consumedRestartToken = emittedRestartToken;
    emittedRestartReason = undefined;
    emittedRestartIntent = undefined;
  }
  // Accepted handlers first promote the fence to one-way restart drain, so
  // this rollback becomes a no-op there. Rejected or test-only handlers must
  // reopen admission or the next restart/root would wait forever.
  clearPendingRestartSignalAdmission();
}

function rollBackGatewayRestartEmission(): void {
  emittedRestartToken = consumedRestartToken;
  emittedRestartReason = undefined;
  emittedRestartIntent = undefined;
  consumeGatewaySigusr1RestartAuthorization();
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

export function resolveGatewayRestartDeferralTimeoutMs(timeoutMs: unknown): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS;
  }
  if (timeoutMs <= 0) {
    return undefined;
  }
  return Math.floor(timeoutMs);
}

function canReplacePendingRestartEmitHooks(
  hooks: RestartEmitHooks | undefined,
  sessionKey: string | undefined,
): boolean {
  if (!hooks) {
    return true;
  }
  return pendingRestartSessionKey === undefined || pendingRestartSessionKey === sessionKey;
}

// Returns true when the new hooks took ownership of the pending restart slot.
// Coalesced callers from a different sessionKey are rejected to prevent the
// cross-session continuation overwrite documented in #86742 (CWE-200).
function updatePendingRestartEmitHooks(
  hooks: RestartEmitHooks | undefined,
  sessionKey: string | undefined,
): boolean {
  if (!canReplacePendingRestartEmitHooks(hooks, sessionKey)) {
    return false;
  }
  if (!hooks) {
    return false;
  }
  pendingRestartEmitHooks = hooks;
  if (sessionKey !== undefined) {
    pendingRestartSessionKey = sessionKey;
  }
  return true;
}

async function rejectPreparedRestartHook(hooks: RestartEmitHooks | undefined): Promise<void> {
  try {
    await hooks?.afterEmitRejected?.();
  } catch {}
}

async function emitPreparedGatewayRestartUnderAdmission(
  hooks?: RestartEmitHooks,
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
  transientGeneration = restartTransientGeneration,
): Promise<void> {
  if (transientGeneration !== restartTransientGeneration) {
    return;
  }
  let nextHooks = hooks ?? pendingRestartEmitHooks;
  // Keep pendingRestartSessionKey alive across the await beforeEmit() window:
  // a different-session caller that coalesces while preparation runs would
  // otherwise slip past the updatePendingRestartEmitHooks session guard and
  // chain its own hooks (#86742, the CWE-200 in-flight preparation race).
  if (!hooks) {
    pendingRestartEmitHooks = undefined;
  }
  let preparedHooks: RestartEmitHooks | undefined;
  while (nextHooks) {
    if (preparedHooks) {
      await rejectPreparedRestartHook(preparedHooks);
      preparedHooks = undefined;
      if (transientGeneration !== restartTransientGeneration) {
        return;
      }
    }
    try {
      await nextHooks.beforeEmit?.();
      preparedHooks = nextHooks;
    } catch (err) {
      restartLog.warn(
        `restart preparation failed; restart will continue without it: ${String(err)}`,
      );
    }
    if (transientGeneration !== restartTransientGeneration) {
      await rejectPreparedRestartHook(preparedHooks);
      return;
    }
    if (hooks) {
      break;
    }
    nextHooks = pendingRestartEmitHooks;
    pendingRestartEmitHooks = undefined;
  }
  if (!hooks) {
    pendingRestartSessionKey = undefined;
  }

  // A managed update can coalesce while beforeEmit awaits. Promote that reason
  // at the last possible moment so the run loop performs a process exit.
  const preferredReason = shouldPreferRestartReason(pendingRestartReason, reasonOverride)
    ? pendingRestartReason
    : undefined;
  const emitted = emitGatewayRestartWithSignalAdmission(
    preferredReason ?? reasonOverride,
    preferredReason && intent ? { ...intent, reason: preferredReason } : intent,
  );
  if (!emitted) {
    await rejectPreparedRestartHook(preparedHooks);
  }
}

async function emitPreparedGatewayRestart(
  hooks?: RestartEmitHooks,
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
): Promise<void> {
  const transientGeneration = restartTransientGeneration;
  try {
    // A delayed restart can become due after host suspension prepared. Independent
    // root admission makes the transition atomic: due restarts block preparation,
    // while a prepared suspension defers emission until it resumes.
    await runWithGatewayIndependentRootWorkAdmission(async () => {
      if (transientGeneration !== restartTransientGeneration) {
        return;
      }
      await emitPreparedGatewayRestartUnderAdmission(
        hooks,
        reasonOverride,
        intent,
        transientGeneration,
      );
    });
  } catch (err) {
    if (!isGatewayRestartDraining()) {
      throw err;
    }
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
  reason?: string;
  timeoutIntent?: GatewayRestartIntent;
}): void {
  const pollMs = resolveTimerTimeoutMs(opts.pollMs, DEFAULT_DEFERRAL_POLL_MS, 10);
  const maxWaitMs =
    typeof opts.maxWaitMs === "number" && Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs > 0
      ? Math.max(pollMs, Math.floor(opts.maxWaitMs))
      : undefined;

  let pending: number;
  try {
    pending = opts.getPendingCount();
  } catch (err) {
    opts.hooks?.onCheckError?.(err);
    void emitPreparedGatewayRestart(opts.emitHooks, opts.reason);
    return;
  }
  if (pending <= 0) {
    opts.hooks?.onReady?.();
    void emitPreparedGatewayRestart(opts.emitHooks, opts.reason);
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
      void emitPreparedGatewayRestart(opts.emitHooks, opts.reason);
      return;
    }
    if (current <= 0) {
      clearInterval(poll);
      activeDeferralPolls.delete(poll);
      opts.hooks?.onReady?.();
      void emitPreparedGatewayRestart(opts.emitHooks, opts.reason);
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
      void emitPreparedGatewayRestart(opts.emitHooks, opts.reason, opts.timeoutIntent);
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
  // Fall back to bootstrap, which loads RunAtLoad agents without a follow-up kickstart.
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
  if (boot.status === 0) {
    return { ok: true, method: "launchctl", tried };
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
  mode: "emit" | "signal" | "supervisor";
  coalesced: boolean;
  cooldownMsApplied: number;
  // True iff the caller's emitHooks own the pending restart slot. Coalesced
  // requests from a different sessionKey are rejected to protect the existing
  // session's continuation (#86742).
  emitHooksQueued: boolean;
};

export function scheduleGatewaySigusr1Restart(opts?: {
  delayMs?: number;
  reason?: string;
  audit?: RestartAuditInfo;
  emitHooks?: RestartEmitHooks;
  preservePendingEmitHooksOnDeferralBypass?: boolean;
  sessionKey?: string;
  skipDeferral?: boolean;
  skipCooldown?: boolean;
}): ScheduledRestart {
  const delayMsRaw =
    typeof opts?.delayMs === "number" && Number.isFinite(opts.delayMs)
      ? Math.floor(opts.delayMs)
      : 2000;
  const delayMs = Math.min(Math.max(delayMsRaw, 0), 60_000);
  const reason = normalizeRestartIntentReason(opts?.reason);
  const hasSigusr1Listener = process.listenerCount("SIGUSR1") > 0;
  const mode = hasSigusr1Listener ? "emit" : process.platform === "win32" ? "supervisor" : "signal";
  const nowMs = Date.now();
  const skipCooldown = opts?.skipCooldown === true;
  const cooldownMsApplied = skipCooldown
    ? 0
    : Math.max(0, lastRestartEmittedAt + RESTART_COOLDOWN_MS - nowMs);
  const requestedDueAt = nowMs + delayMs + cooldownMsApplied;
  const skipDeferral = opts?.skipDeferral === true;
  let nextPendingEmitHooks = opts?.emitHooks;
  let nextPendingSessionKey = opts?.sessionKey;

  if (hasUnconsumedRestartSignal()) {
    if (shouldPreferRestartReason(reason, emittedRestartReason)) {
      emittedRestartReason = reason;
      if (emittedRestartIntent) {
        // Preserve the already-authorized force bit; only the display/recovery reason is upgraded.
        emittedRestartIntent = { ...emittedRestartIntent, reason };
      }
    }
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
      // SIGUSR1 already emitted; the new caller's hooks cannot run for this cycle.
      emitHooksQueued: false,
    };
  }

  if (pendingRestartTimer || pendingRestartPreparing) {
    const remainingMs = pendingRestartPreparing ? 0 : Math.max(0, pendingRestartDueAt - nowMs);
    if (pendingRestartPreparing && skipDeferral && activeDeferralPolls.size > 0) {
      restartLog.warn(
        `restart request bypassed active deferral reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} ${formatRestartAudit(opts?.audit)}`,
      );
      clearActiveDeferralPolls();
      pendingRestartReason = reason;
      // Hookless forced restarts that own no sentinel may preserve an accepted
      // pending hook; update/handoff callers rely on the default clear path.
      const preservePendingHooks =
        opts?.preservePendingEmitHooksOnDeferralBypass === true &&
        opts?.emitHooks === undefined &&
        pendingRestartSessionKey !== undefined;
      if (!preservePendingHooks) {
        pendingRestartEmitHooks = opts?.emitHooks;
        pendingRestartSessionKey = opts?.sessionKey;
      }
      void emitPreparedGatewayRestart(undefined, reason);
      return {
        ok: true,
        pid: process.pid,
        signal: "SIGUSR1",
        delayMs: 0,
        reason,
        mode,
        coalesced: false,
        cooldownMsApplied,
        emitHooksQueued: opts?.emitHooks !== undefined,
      };
    }
    const shouldUpgradeToSkipDeferral = skipDeferral && !pendingRestartSkipDeferral;
    const shouldPullEarlier =
      !pendingRestartPreparing &&
      (requestedDueAt < pendingRestartDueAt || shouldUpgradeToSkipDeferral);
    if (shouldPullEarlier) {
      const preservePendingHooks =
        opts?.preservePendingEmitHooksOnDeferralBypass === true &&
        opts?.emitHooks === undefined &&
        pendingRestartSessionKey !== undefined;
      if (
        !preservePendingHooks &&
        !canReplacePendingRestartEmitHooks(opts?.emitHooks, opts?.sessionKey)
      ) {
        restartLog.warn(
          `restart continuation dropped: another session owns the pending restart (callerSessionKey=${opts?.sessionKey ?? "unspecified"} pendingSessionKey=${pendingRestartSessionKey ?? "unspecified"})`,
        );
        if (pendingRestartTimer) {
          clearTimeout(pendingRestartTimer);
        }
        pendingRestartTimer = null;
        pendingRestartDueAt = requestedDueAt;
        pendingRestartReason = reason;
        pendingRestartSkipDeferral = pendingRestartSkipDeferral || skipDeferral;
        armPendingRestartTimer(requestedDueAt, nowMs);
        return {
          ok: true,
          pid: process.pid,
          signal: "SIGUSR1",
          delayMs: Math.max(0, requestedDueAt - nowMs),
          reason,
          mode,
          coalesced: true,
          cooldownMsApplied,
          emitHooksQueued: false,
        };
      }
      const preservedEmitHooks = preservePendingHooks ? pendingRestartEmitHooks : undefined;
      const preservedSessionKey = preservePendingHooks ? pendingRestartSessionKey : undefined;
      restartLog.warn(
        `restart request rescheduled earlier reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} oldDelayMs=${remainingMs} newDelayMs=${Math.max(0, requestedDueAt - nowMs)} ${formatRestartAudit(opts?.audit)}`,
      );
      clearPendingScheduledRestart();
      if (preservePendingHooks) {
        nextPendingEmitHooks = preservedEmitHooks;
        nextPendingSessionKey = preservedSessionKey;
      }
    } else {
      if (shouldPreferRestartReason(reason, pendingRestartReason)) {
        pendingRestartReason = reason;
      }
      pendingRestartSkipDeferral = pendingRestartSkipDeferral || skipDeferral;
      restartLog.warn(
        `restart request coalesced (already scheduled) reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} delayMs=${remainingMs} ${formatRestartAudit(opts?.audit)}`,
      );
      const emitHooksQueued = updatePendingRestartEmitHooks(opts?.emitHooks, opts?.sessionKey);
      if (opts?.emitHooks && !emitHooksQueued) {
        restartLog.warn(
          `restart continuation dropped: another session owns the pending restart (callerSessionKey=${opts.sessionKey ?? "unspecified"} pendingSessionKey=${pendingRestartSessionKey ?? "unspecified"})`,
        );
      }
      return {
        ok: true,
        pid: process.pid,
        signal: "SIGUSR1",
        delayMs: remainingMs,
        reason,
        mode,
        coalesced: true,
        cooldownMsApplied,
        emitHooksQueued,
      };
    }
  }

  pendingRestartDueAt = requestedDueAt;
  pendingRestartReason = reason;
  pendingRestartEmitHooks = nextPendingEmitHooks;
  pendingRestartSessionKey = nextPendingSessionKey;
  pendingRestartSkipDeferral = skipDeferral;
  armPendingRestartTimer(requestedDueAt, nowMs);
  return {
    ok: true,
    pid: process.pid,
    signal: "SIGUSR1",
    delayMs: Math.max(0, requestedDueAt - nowMs),
    reason,
    mode,
    coalesced: false,
    cooldownMsApplied,
    emitHooksQueued: opts?.emitHooks !== undefined,
  };
}

function resetSigusr1TransientStateForTest(): void {
  restartTransientGeneration += 1;
  sigusr1AuthorizedCount = 0;
  sigusr1AuthorizedUntil = 0;
  restartCycleToken = 0;
  emittedRestartToken = 0;
  consumedRestartToken = 0;
  emittedRestartReason = undefined;
  emittedRestartIntent = undefined;
  lastRestartEmittedAt = 0;
  clearActiveDeferralPolls();
  clearPendingScheduledRestart();
  clearPendingRestartSignalAdmission();
}

export const testing = {
  resetSigusr1TransientState: resetSigusr1TransientStateForTest,
  resetSigusr1State() {
    resetSigusr1TransientStateForTest();
    sigusr1ExternalAllowed = false;
    preRestartCheck = null;
  },
};
export { testing as __testing };
