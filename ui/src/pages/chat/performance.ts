import type { EventLogEntry } from "../../api/event-log.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

type ChatPerformanceHost = {
  eventLogBuffer?: unknown[];
  renderLifecycle?: RenderLifecycle;
};

const EVENT_LOG_LIMIT = 250;

export function controlUiNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function roundedControlUiDurationMs(durationMs: number): number {
  return Math.max(0, Math.round(durationMs));
}

function runAfterPaint(callback: () => void, complete: () => void): () => void {
  let active = true;
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  const run = () => {
    if (!active) {
      return;
    }
    active = false;
    try {
      callback();
    } finally {
      complete();
    }
  };
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    queueMicrotask(run);
  } else {
    let firstFrameCompleted = false;
    const scheduledFirstFrame = window.requestAnimationFrame(() => {
      firstFrameCompleted = true;
      firstFrame = null;
      if (!active) {
        return;
      }
      let secondFrameCompleted = false;
      const scheduledSecondFrame = window.requestAnimationFrame(() => {
        secondFrameCompleted = true;
        secondFrame = null;
        run();
      });
      if (!secondFrameCompleted) {
        secondFrame = scheduledSecondFrame;
      }
    });
    if (!firstFrameCompleted) {
      firstFrame = scheduledFirstFrame;
    }
  }
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (firstFrame !== null) {
      window.cancelAnimationFrame(firstFrame);
      firstFrame = null;
    }
    if (secondFrame !== null) {
      window.cancelAnimationFrame(secondFrame);
      secondFrame = null;
    }
  };
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

export function recordControlUiPerformanceEvent(
  host: ChatPerformanceHost,
  event: string,
  payload: Record<string, unknown>,
  opts?: { warn?: boolean; console?: boolean; maxBufferedEventsForType?: number },
): void {
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
  }
  if (opts?.console === false) {
    return;
  }
  const logger = opts?.warn === true ? console.warn : console.debug;
  logger(`[openclaw] ${event}`, payload);
}

export function scheduleControlUiAfterPaint(
  host: Pick<ChatPerformanceHost, "renderLifecycle">,
  callback: () => void,
): void {
  if (host.renderLifecycle) {
    host.renderLifecycle.afterCommit((complete) => runAfterPaint(callback, complete));
    return;
  }
  // Renderer-free unit hosts have no DOM commit to await.
  runAfterPaint(callback, () => undefined);
}
