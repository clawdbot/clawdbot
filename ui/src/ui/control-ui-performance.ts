import type { EventLogEntry } from "./app-events.ts";
import type { GatewayRequestTiming } from "./gateway.ts";
import type { Tab } from "./navigation.ts";

type ControlUiPerformanceHost = {
  tab: Tab;
  isConnected?: boolean;
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
const SLOW_RENDER_MS = 16;
const VERY_SLOW_RENDER_MS = 50;
const RESPONSIVENESS_ENTRY_MS = 50;
const RESPONSIVENESS_EVENT_LOG_LIMIT = 50;
const RENDER_EVENT_LOG_LIMIT = 50;

type ControlUiResponsivenessObserver = {
  disconnect: () => void;
};

type PerformanceObserverCtor = {
  readonly supportedEntryTypes?: readonly string[];
  new (callback: PerformanceObserverCallback): PerformanceObserver;
};

type LongAnimationFrameScriptTiming = {
  duration?: number;
  invoker?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
};

type ResponsivenessPerformanceEntry = PerformanceEntry & {
  blockingDuration?: number;
  scripts?: LongAnimationFrameScriptTiming[];
};

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
  opts?: { warn?: boolean; console?: boolean; maxBufferedEventsForType?: number },
) {
  const entry: EventLogEntry = { ts: Date.now(), event, payload };
  if (Array.isArray(host.eventLogBuffer)) {
    const existingBuffer =
      typeof opts?.maxBufferedEventsForType === "number"
        ? keepLatestBufferedEventsForType(
            host.eventLogBuffer,
            event,
            Math.max(0, opts.maxBufferedEventsForType - 1),
          )
        : host.eventLogBuffer;
    host.eventLogBuffer = [entry, ...existingBuffer].slice(0, EVENT_LOG_LIMIT);
    if (host.tab === "debug" || host.tab === "overview") {
      host.eventLog = host.eventLogBuffer;
    }
  }
  if (opts?.console === false) {
    return;
  }
  logPerformanceEvent(event, payload, opts?.warn === true);
}

function keepLatestBufferedEventsForType(
  entries: unknown[],
  event: string,
  maxExistingForType: number,
): unknown[] {
  let keptForType = 0;
  return entries.filter((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("event" in entry) ||
      (entry as { event?: unknown }).event !== event
    ) {
      return true;
    }
    keptForType += 1;
    return keptForType <= maxExistingForType;
  });
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
    if (host.isConnected === false || host.controlUiTabPaintSeq !== seq || host.tab !== tab) {
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

export function recordControlUiRenderTiming(
  host: ControlUiPerformanceHost,
  surface: string,
  payload: Record<string, unknown>,
) {
  const durationMs =
    typeof payload.durationMs === "number"
      ? roundedControlUiDurationMs(payload.durationMs)
      : undefined;
  if (durationMs == null || durationMs < SLOW_RENDER_MS) {
    return;
  }
  runAfterMicrotask(() => {
    recordControlUiPerformanceEvent(
      host,
      "control-ui.render",
      {
        surface,
        ...payload,
        durationMs,
        slow: true,
      },
      {
        warn: durationMs >= VERY_SLOW_RENDER_MS,
        maxBufferedEventsForType: RENDER_EVENT_LOG_LIMIT,
      },
    );
  });
}

function getPerformanceObserverCtor(): PerformanceObserverCtor | null {
  const observer = globalThis.PerformanceObserver;
  return typeof observer === "function" ? (observer as PerformanceObserverCtor) : null;
}

function normalizeScriptSourceUrl(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) {
    return undefined;
  }
  try {
    const url = new URL(sourceUrl, globalThis.location?.href);
    return url.pathname;
  } catch {
    return sourceUrl.split(/[?#]/, 1)[0];
  }
}

function getTopLongAnimationFrameScript(
  scripts: LongAnimationFrameScriptTiming[] | undefined,
): Record<string, unknown> | undefined {
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return undefined;
  }
  let topScript: LongAnimationFrameScriptTiming | undefined;
  for (const script of scripts) {
    if (!topScript || (script.duration ?? 0) > (topScript.duration ?? 0)) {
      topScript = script;
    }
  }
  if (!topScript) {
    return undefined;
  }
  return {
    durationMs: roundedControlUiDurationMs(topScript.duration ?? 0),
    invoker: topScript.invoker,
    sourceUrl: normalizeScriptSourceUrl(topScript.sourceURL),
    sourceFunctionName: topScript.sourceFunctionName,
  };
}

function recordResponsivenessEntry(
  host: ControlUiPerformanceHost,
  entryType: "long-animation-frame" | "longtask",
  entry: ResponsivenessPerformanceEntry,
) {
  const durationMs = roundedControlUiDurationMs(entry.duration);
  if (durationMs < RESPONSIVENESS_ENTRY_MS) {
    return;
  }
  recordControlUiPerformanceEvent(
    host,
    `control-ui.${entryType}`,
    {
      tab: host.tab,
      name: entry.name,
      startTimeMs: roundedControlUiDurationMs(entry.startTime),
      durationMs,
      blockingDurationMs:
        typeof entry.blockingDuration === "number"
          ? roundedControlUiDurationMs(entry.blockingDuration)
          : undefined,
      scriptCount: Array.isArray(entry.scripts) ? entry.scripts.length : undefined,
      topScript: getTopLongAnimationFrameScript(entry.scripts),
    },
    { warn: true, maxBufferedEventsForType: RESPONSIVENESS_EVENT_LOG_LIMIT },
  );
}

export function startControlUiResponsivenessObserver(
  host: ControlUiPerformanceHost,
): ControlUiResponsivenessObserver | null {
  const Observer = getPerformanceObserverCtor();
  const supportedEntryTypes = Observer?.supportedEntryTypes ?? [];
  const entryType = supportedEntryTypes.includes("long-animation-frame")
    ? "long-animation-frame"
    : supportedEntryTypes.includes("longtask")
      ? "longtask"
      : null;
  if (!Observer || !entryType) {
    return null;
  }

  const observer = new Observer((list) => {
    for (const entry of list.getEntries() as ResponsivenessPerformanceEntry[]) {
      recordResponsivenessEntry(host, entryType, entry);
    }
  });
  try {
    observer.observe({ type: entryType, buffered: true });
  } catch {
    return null;
  }
  return observer;
}
