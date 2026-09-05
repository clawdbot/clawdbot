import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";

const EVENT_LOOP_PRESSURE_THRESHOLD_MS = 500;
const PRESSURE_COOLDOWN_MS = 120_000;

export type SchedulerPressureSnapshot = {
  eventLoopDelayP99Ms?: number;
  rssBytes?: number;
  memoryPressure?: {
    level: "warning" | "critical";
    reason: "rss_threshold" | "heap_threshold" | "rss_growth";
    observedAt: number;
  };
  pressured: boolean;
  pressureUntil?: number;
  configuredCronConcurrency?: number;
  effectiveCronConcurrency?: number;
};

const state: {
  subscribed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  eventLoopDelayP99Ms?: number;
  rssBytes?: number;
  eventLoopPressureUntil: number;
  memoryPressureUntil: number;
  memoryPressure?: SchedulerPressureSnapshot["memoryPressure"];
  configuredCronConcurrency?: number;
  effectiveCronConcurrency?: number;
  listeners: Set<(snapshot: SchedulerPressureSnapshot) => void>;
} = {
  subscribed: false,
  timer: null,
  eventLoopPressureUntil: 0,
  memoryPressureUntil: 0,
  listeners: new Set(),
};

function createSnapshot(now = Date.now()): SchedulerPressureSnapshot {
  const pressureUntil = Math.max(state.eventLoopPressureUntil, state.memoryPressureUntil);
  const pressured = pressureUntil > now;
  return {
    ...(state.eventLoopDelayP99Ms !== undefined
      ? { eventLoopDelayP99Ms: state.eventLoopDelayP99Ms }
      : {}),
    ...(state.rssBytes !== undefined ? { rssBytes: state.rssBytes } : {}),
    ...(state.memoryPressure ? { memoryPressure: state.memoryPressure } : {}),
    pressured,
    ...(pressured ? { pressureUntil } : {}),
    ...(state.configuredCronConcurrency !== undefined
      ? { configuredCronConcurrency: state.configuredCronConcurrency }
      : {}),
    ...(state.effectiveCronConcurrency !== undefined
      ? { effectiveCronConcurrency: state.effectiveCronConcurrency }
      : {}),
  };
}

function notify(now = Date.now()): void {
  const snapshot = createSnapshot(now);
  for (const listener of state.listeners) {
    listener(snapshot);
  }
}

function scheduleExpiry(now = Date.now()): void {
  clearTimeout(state.timer ?? undefined);
  state.timer = null;
  const pressureUntil = Math.max(state.eventLoopPressureUntil, state.memoryPressureUntil);
  if (pressureUntil <= now) {
    return;
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    const currentNow = Date.now();
    if (state.eventLoopPressureUntil <= currentNow) {
      state.eventLoopPressureUntil = 0;
    }
    if (state.memoryPressureUntil <= currentNow) {
      state.memoryPressureUntil = 0;
      state.memoryPressure = undefined;
    }
    notify(currentNow);
    scheduleExpiry(currentNow);
  }, pressureUntil - now);
  state.timer.unref?.();
}

function recordDiagnosticEvent(event: DiagnosticEventPayload, now = Date.now()): void {
  if (event.type === "diagnostic.liveness.warning") {
    state.eventLoopDelayP99Ms = event.eventLoopDelayP99Ms;
    if ((event.eventLoopDelayP99Ms ?? 0) > EVENT_LOOP_PRESSURE_THRESHOLD_MS) {
      state.eventLoopPressureUntil = now + PRESSURE_COOLDOWN_MS;
    }
  } else if (event.type === "diagnostic.memory.sample") {
    state.rssBytes = event.memory.rssBytes;
  } else if (event.type === "diagnostic.memory.pressure") {
    state.rssBytes = event.memory.rssBytes;
    state.memoryPressureUntil = now + PRESSURE_COOLDOWN_MS;
    state.memoryPressure = {
      level: event.level,
      reason: event.reason,
      observedAt: now,
    };
  } else {
    return;
  }
  notify(now);
  scheduleExpiry(now);
}

export function startSchedulerPressureTracking(): void {
  if (state.subscribed) {
    return;
  }
  state.subscribed = true;
  onInternalDiagnosticEvent((event) => {
    recordDiagnosticEvent(event);
  });
}

export function onSchedulerPressureChanged(
  listener: (snapshot: SchedulerPressureSnapshot) => void,
): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function setSchedulerCronConcurrency(
  configuredCronConcurrency: number,
  effectiveCronConcurrency: number,
): void {
  state.configuredCronConcurrency = configuredCronConcurrency;
  state.effectiveCronConcurrency = effectiveCronConcurrency;
}

export function getSchedulerPressureSnapshot(now = Date.now()): SchedulerPressureSnapshot {
  return createSnapshot(now);
}

export const testing = {
  recordDiagnosticEvent,
  reset() {
    clearTimeout(state.timer ?? undefined);
    state.timer = null;
    state.eventLoopDelayP99Ms = undefined;
    state.rssBytes = undefined;
    state.eventLoopPressureUntil = 0;
    state.memoryPressureUntil = 0;
    state.memoryPressure = undefined;
    state.configuredCronConcurrency = undefined;
    state.effectiveCronConcurrency = undefined;
  },
};
