import type { EventLogEntry } from "./app-events.ts";
import type { GatewayRequestTiming } from "./gateway.ts";
import type { Tab } from "./navigation.ts";

type ControlUiPerformanceHost = {
  tab: Tab;
  eventLog?: unknown[];
  eventLogBuffer?: unknown[];
  requestUpdate?: () => void;
  updateComplete?: Promise<unknown>;
  controlUiRefreshSeq?: number;
  controlUiTabPaintSeq?: number;
};

export type ControlUiRefreshRun = {
  seq: number;
  tab: Tab;
  startedAtMs: number;
};

const EVENT_LOG_LIMIT = 250;
const SLOW_RPC_MS = 1_000;

export function controlUiNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function roundedControlUiDurationMs(durationMs: number): number {
  return Math.max(0, Math.round(durationMs));
}

function runAfterMicrotask(callback: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
}

function runAfterPaint(callback: () => void): void {
  const raf =
    typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : null;
  if (!raf) {
    runAfterMicrotask(callback);
    return;
  }
  raf(() => raf(callback));
}

function logPerformanceEvent(event: string, payload: Record<string, unknown>, warn: boolean) {
  const logger = warn ? console.warn : console.debug;
  if (typeof logger !== "function") {
    return;
  }
  logger(`[openclaw] ${event}`, payload);
}

export function recordControlUiPerformanceEvent(
  host: ControlUiPerformanceHost,
  event: string,
  payload: Record<string, unknown>,
  opts?: { warn?: boolean; console?: boolean },
) {
  const entry: EventLogEntry = { ts: Date.now(), event, payload };
  if (Array.isArray(host.eventLogBuffer)) {
    host.eventLogBuffer = [entry, ...host.eventLogBuffer].slice(0, EVENT_LOG_LIMIT);
    if (host.tab === "debug" || host.tab === "overview") {
      host.eventLog = host.eventLogBuffer;
    }
  }
  if (opts?.console === false) {
    return;
  }
  logPerformanceEvent(event, payload, opts?.warn === true);
}

export function scheduleControlUiTabVisibleTiming(
  host: ControlUiPerformanceHost,
  previousTab: Tab,
  tab: Tab,
) {
  const seq = (host.controlUiTabPaintSeq ?? 0) + 1;
  host.controlUiTabPaintSeq = seq;
  const startedAtMs = controlUiNowMs();
  host.requestUpdate?.();

  const record = () => {
    if (host.controlUiTabPaintSeq !== seq || host.tab !== tab) {
      return;
    }
    recordControlUiPerformanceEvent(host, "control-ui.tab.visible", {
      previousTab,
      tab,
      durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
    });
  };

  void Promise.resolve(host.updateComplete)
    .catch(() => undefined)
    .then(() => runAfterPaint(record));
}

export function beginControlUiRefresh(
  host: ControlUiPerformanceHost,
  tab: Tab,
): ControlUiRefreshRun {
  const seq = (host.controlUiRefreshSeq ?? 0) + 1;
  host.controlUiRefreshSeq = seq;
  const run = { seq, tab, startedAtMs: controlUiNowMs() };
  recordControlUiPerformanceEvent(
    host,
    "control-ui.refresh",
    { tab, phase: "start" },
    { console: false },
  );
  return run;
}

export function isCurrentControlUiRefresh(
  host: ControlUiPerformanceHost,
  run: ControlUiRefreshRun,
): boolean {
  return host.controlUiRefreshSeq === run.seq && host.tab === run.tab;
}

export function finishControlUiRefresh(
  host: ControlUiPerformanceHost,
  run: ControlUiRefreshRun,
  status: "ok" | "error",
) {
  if (!isCurrentControlUiRefresh(host, run)) {
    return;
  }
  recordControlUiPerformanceEvent(
    host,
    "control-ui.refresh",
    {
      tab: run.tab,
      phase: "end",
      status,
      durationMs: roundedControlUiDurationMs(controlUiNowMs() - run.startedAtMs),
    },
    { console: false },
  );
}

export function recordControlUiRpcTiming(
  host: ControlUiPerformanceHost,
  timing: GatewayRequestTiming,
) {
  const durationMs = roundedControlUiDurationMs(timing.durationMs);
  const warn = !timing.ok || durationMs >= SLOW_RPC_MS;
  recordControlUiPerformanceEvent(
    host,
    "control-ui.rpc",
    {
      id: timing.id,
      method: timing.method,
      ok: timing.ok,
      durationMs,
      slow: durationMs >= SLOW_RPC_MS,
      errorCode: timing.errorCode,
    },
    { warn },
  );
}
