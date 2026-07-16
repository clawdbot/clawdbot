// Process-local retry scheduler for the durable session delivery queue.
import { computeBackoffMs } from "./delivery-recovery.shared.js";
import {
  drainPendingSessionDeliveries,
  loadPendingSessionDeliveries,
  loadPendingSessionDelivery,
  type DeliverSessionDeliveryFn,
  type QueuedSessionDelivery,
  type SessionDeliveryRecoveryLogger,
  type SettleSessionDeliveryFn,
} from "./session-delivery-queue.js";

type SessionDeliveryRuntime = {
  deliver: DeliverSessionDeliveryFn;
  drain?: typeof drainPendingSessionDeliveries;
  log: SessionDeliveryRecoveryLogger;
  reloadPending?: typeof loadPendingSessionDelivery;
  listPending?: typeof loadPendingSessionDeliveries;
  onSettled?: SettleSessionDeliveryFn;
};

const RUNTIME_RELOAD_RETRY_MS = 1_000;
let runtime: SessionDeliveryRuntime | undefined;
let runtimeGeneration = 0;
const scheduledEntries = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number }>();
const runningEntries = new Map<string, number>();
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
  if (entry.retryCount <= 0) {
    return claimDelayMs;
  }
  const attemptedAt = entry.lastAttemptAt ?? entry.enqueuedAt;
  return Math.max(claimDelayMs, attemptedAt + computeBackoffMs(entry.retryCount) - Date.now());
}

function armSessionDeliveryId(id: string, delayMs: number, generation: number): void {
  if (!runtime || generation !== runtimeGeneration) {
    return;
  }
  const dueAt = Date.now() + delayMs;
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
  if (runningEntries.get(entry.id) === generation) {
    return;
  }
  armSessionDeliveryId(entry.id, Math.max(minimumDelayMs, resolveRetryDelayMs(entry)), generation);
}

async function runScheduledSessionDelivery(id: string, generation: number): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime || generation !== runtimeGeneration) {
    return;
  }
  if (runningEntries.get(id) === generation) {
    return;
  }
  runningEntries.set(id, generation);
  let pending: QueuedSessionDelivery | null = null;
  try {
    await (activeRuntime.drain ?? drainPendingSessionDeliveries)({
      drainKey: `runtime:${id}`,
      logLabel: "session delivery",
      log: activeRuntime.log,
      deliver: activeRuntime.deliver,
      onSettled: activeRuntime.onSettled,
      selectEntry: (entry) => ({ match: entry.id === id }),
    });
  } catch (error) {
    activeRuntime.log.error(`session delivery: runtime drain failed for ${id}: ${String(error)}`);
  }
  try {
    if (!runtime || generation !== runtimeGeneration) {
      return;
    }
    const reloadPending = activeRuntime.reloadPending ?? loadPendingSessionDelivery;
    pending = await reloadPending(id).catch((error: unknown) => {
      activeRuntime.log.error(`session delivery: failed to reload ${id}: ${String(error)}`);
      // The durable row may still be pending. Retry the lookup so one transient
      // database error cannot orphan it until the next gateway restart.
      armSessionDeliveryId(id, RUNTIME_RELOAD_RETRY_MS, generation);
      return null;
    });
  } finally {
    if (runningEntries.get(id) === generation) {
      runningEntries.delete(id);
    }
  }
  if (pending) {
    // Any still-pending row means the drain deferred, failed, or was owned
    // elsewhere. Never poll an unchanged immediately-due row at timer speed.
    armSessionDelivery(pending, generation, RUNTIME_RELOAD_RETRY_MS);
  }
}

/** Register the gateway-owned delivery callback and return its lifecycle stop handle. */
export function startSessionDeliveryRuntime(params: SessionDeliveryRuntime): () => void {
  runtimeGeneration += 1;
  const generation = runtimeGeneration;
  clearScheduledEntries();
  runtime = params;
  return () => {
    if (runtimeGeneration !== generation) {
      return;
    }
    runtimeGeneration += 1;
    runtime = undefined;
    clearScheduledEntries();
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

const testing = {
  reset(): void {
    runtimeGeneration += 1;
    runtime = undefined;
    clearScheduledEntries();
  },
};

(globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.sessionDeliveryQueueRuntimeTestApi")
] = testing;
