// Process-local retry scheduler for the durable session delivery queue.
import { createDeferredCore } from "../shared/deferred.js";
import { computeBackoffMs } from "./delivery-recovery.shared.js";
import {
  drainPendingSessionDelivery,
  type DeliverSessionDeliveryFn,
  type SessionDeliveryRecoveryLogger,
  type SettleSessionDeliveryFn,
} from "./session-delivery-queue-recovery.js";
import {
  loadPendingSessionDeliveries,
  loadPendingSessionDelivery,
  type QueuedSessionDelivery,
} from "./session-delivery-queue-storage.js";

type SessionDeliveryRuntime = {
  deliver: DeliverSessionDeliveryFn;
  drain?: typeof drainPendingSessionDelivery;
  log: SessionDeliveryRecoveryLogger;
  reloadPending?: typeof loadPendingSessionDelivery;
  listPending?: typeof loadPendingSessionDeliveries;
  onSettled?: SettleSessionDeliveryFn;
};

const RUNTIME_RELOAD_RETRY_MS = 1_000;
let runtime: (SessionDeliveryRuntime & { runningEntries: Map<string, Promise<void>> }) | undefined;
let runtimeGeneration = 0;
const scheduledEntries = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number }>();
let pendingScanTimer: ReturnType<typeof setTimeout> | undefined;

function clearScheduledEntries(): void {
  for (const scheduled of scheduledEntries.values()) {
    clearTimeout(scheduled.timer);
  }
  scheduledEntries.clear();
  if (pendingScanTimer) {
    clearTimeout(pendingScanTimer);
    pendingScanTimer = undefined;
  }
}

function armPendingScan(generation: number): void {
  if (!runtime || generation !== runtimeGeneration || pendingScanTimer) {
    return;
  }
  pendingScanTimer = setTimeout(() => {
    pendingScanTimer = undefined;
    void schedulePendingSessionDeliveries();
  }, RUNTIME_RELOAD_RETRY_MS);
  pendingScanTimer.unref?.();
}

function resolveRetryDelayMs(entry: QueuedSessionDelivery): number {
  const claimDelayMs = Math.max(0, (entry.availableAt ?? 0) - Date.now());
  const deadlineDelayMs =
    entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion"
      ? Math.max(0, entry.owner.deadlineAt - Date.now())
      : Number.POSITIVE_INFINITY;
  if (entry.retryCount <= 0) {
    return Math.min(claimDelayMs, deadlineDelayMs);
  }
  if (entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion") {
    return Math.min(deadlineDelayMs, claimDelayMs);
  }
  const attemptedAt = entry.lastAttemptAt ?? entry.enqueuedAt;
  return Math.min(
    deadlineDelayMs,
    Math.max(claimDelayMs, attemptedAt + computeBackoffMs(entry.retryCount) - Date.now()),
  );
}

function armSessionDeliveryId(id: string, delayMs: number, generation: number): void {
  if (!runtime || generation !== runtimeGeneration) {
    return;
  }
  // Native timers measure elapsed time, so preemption deadlines must ignore wall-clock jumps.
  const dueAt = performance.now() + delayMs;
  const existing = scheduledEntries.get(id);
  if (existing && existing.dueAt <= dueAt) {
    return;
  }
  if (existing) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    scheduledEntries.delete(id);
    void runScheduledSessionDelivery(id, generation);
  }, delayMs);
  timer.unref?.();
  scheduledEntries.set(id, { timer, dueAt });
}

function armSessionDelivery(
  entry: QueuedSessionDelivery,
  generation: number,
  minimumDelayMs = 0,
): void {
  // The active drain owns rearming after its authoritative reload. Coalesce
  // duplicate schedules so they cannot poll the same due row in a timer loop.
  if (runtime?.runningEntries.has(entry.id)) {
    return;
  }
  armSessionDeliveryId(entry.id, Math.max(minimumDelayMs, resolveRetryDelayMs(entry)), generation);
}

async function runScheduledSessionDelivery(id: string, generation: number): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime || generation !== runtimeGeneration) {
    return;
  }
  if (activeRuntime.runningEntries.has(id)) {
    return;
  }
  const settled = createDeferredCore();
  activeRuntime.runningEntries.set(id, settled.promise);
  let pending: QueuedSessionDelivery | null = null;
  try {
    pending = await (activeRuntime.drain ?? drainPendingSessionDelivery)({
      id,
      logLabel: "session delivery",
      log: activeRuntime.log,
      deliver: activeRuntime.deliver,
      onSettled: activeRuntime.onSettled,
    });
  } catch (error) {
    activeRuntime.log.error(`session delivery: runtime drain failed for ${id}: ${String(error)}`);
    if (runtime && generation === runtimeGeneration) {
      // The durable row may still be pending. Retry the exact drain so one
      // transient database error cannot orphan it until the next restart.
      armSessionDeliveryId(id, RUNTIME_RELOAD_RETRY_MS, generation);
    }
  } finally {
    activeRuntime.runningEntries.delete(id);
    settled.resolve();
  }
  if (!runtime || generation !== runtimeGeneration) {
    return;
  }
  if (pending) {
    // Any still-pending row means the drain deferred, failed, or was owned
    // elsewhere. Never poll an unchanged immediately-due row at timer speed.
    armSessionDelivery(pending, generation, RUNTIME_RELOAD_RETRY_MS);
  }
}

/** Register delivery callbacks; stop fences scheduling synchronously and joins admitted drains. */
export function startSessionDeliveryRuntime(params: SessionDeliveryRuntime): () => Promise<void> {
  runtimeGeneration += 1;
  const generation = runtimeGeneration;
  clearScheduledEntries();
  const activeRuntime = { ...params, runningEntries: new Map<string, Promise<void>>() };
  runtime = activeRuntime;
  let stopPromise: Promise<void> | undefined;
  return () => {
    if (runtimeGeneration === generation) {
      runtimeGeneration += 1;
      runtime = undefined;
      clearScheduledEntries();
    }
    // A replacement owns its own drains. Retained stops join only this owner,
    // including settlement writes after its delivery callback has returned.
    stopPromise ??= Promise.all(activeRuntime.runningEntries.values()).then(() => {});
    return stopPromise;
  };
}

/** Schedule one durable entry when a gateway runtime is available. */
export async function scheduleSessionDelivery(id: string): Promise<boolean> {
  const generation = runtimeGeneration;
  const activeRuntime = runtime;
  if (!activeRuntime) {
    return false;
  }
  let entry: QueuedSessionDelivery | null;
  try {
    entry = await (activeRuntime.reloadPending ?? loadPendingSessionDelivery)(id);
  } catch (error) {
    activeRuntime.log.error(`session delivery: failed to load ${id}: ${String(error)}`);
    armSessionDeliveryId(id, RUNTIME_RELOAD_RETRY_MS, generation);
    return true;
  }
  if (!entry || !runtime || generation !== runtimeGeneration) {
    return !entry;
  }
  armSessionDelivery(entry, generation);
  return true;
}

/** Schedule every pending entry after startup recovery installs the runtime owner. */
export async function schedulePendingSessionDeliveries(): Promise<void> {
  const generation = runtimeGeneration;
  const activeRuntime = runtime;
  if (!activeRuntime) {
    return;
  }
  let entries: QueuedSessionDelivery[];
  try {
    entries = await (activeRuntime.listPending ?? loadPendingSessionDeliveries)();
  } catch (error) {
    activeRuntime.log.error(`session delivery: failed to scan pending entries: ${String(error)}`);
    armPendingScan(generation);
    return;
  }
  if (!runtime || generation !== runtimeGeneration) {
    return;
  }
  for (const entry of entries) {
    armSessionDelivery(entry, generation);
  }
}
