/**
 * Context-pressure awareness for the continuation system.
 *
 * Monitors session token usage relative to the context window and fires
 * system events when pressure bands are crossed. This gives the agent
 * advance warning to evacuate working state before compaction.
 *
 * Post-compaction: fires regardless of context level to inform the session
 * that compaction occurred. The session learns this cycle behaviorally.
 *
 * Band dedup: equality-based. The same band doesn't fire twice consecutively,
 * but a new band (including a lower band after compaction) always fires.
 *
 * First-fire is signalled by `lastFiredBand.has(sessionKey) === false`.
 * That avoids suppressing a first crossing when the computed band is 0.
 *
 * RFC: docs/design/continue-work-signal-v2.md §4.2
 */

import type { SessionEntry } from "../../config/sessions.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("continuation/context-pressure");

const DEFAULT_CONTEXT_PRESSURE_THRESHOLD = 0.8;

/** Pressure-band percentage returned by {@link resolveContextPressureBand}. */
export type PressureBand = number;

/**
 * Per-session dedup state: the last band that fired.
 * Reset when a new lifecycle begins (e.g., after compaction).
 *
 * Absence (`!map.has(sessionKey)`) means the session has never fired —
 * it replaces the prior `-1` magic sentinel.
 */
const lastFiredBand = new Map<string, PressureBand>();

/**
 * Resolve which pressure band the current ratio falls into.
 * Returns 0 if below all bands.
 */
export function resolveContextPressureBand(
  ratio: number,
  threshold: number,
  earlyWarningBand?: number,
): PressureBand {
  if (!Number.isFinite(ratio) || ratio < 0 || !Number.isFinite(threshold) || threshold <= 0) {
    return 0;
  }
  const thresholdPct = Math.round(threshold * 100);
  const earlyWarningMultiplier = earlyWarningBand ?? 0;
  const earlyWarningThreshold =
    Number.isFinite(earlyWarningMultiplier) && earlyWarningMultiplier > 0
      ? threshold * earlyWarningMultiplier
      : 0;
  const pressureBands = [
    ...(earlyWarningThreshold > 0
      ? [{ threshold: earlyWarningThreshold, band: Math.round(earlyWarningThreshold * 100) }]
      : []),
    { threshold, band: thresholdPct },
    ...(threshold < 0.9 ? [{ threshold: 0.9, band: 90 }] : []),
    ...(Math.max(threshold, 0.9) < 0.95 ? [{ threshold: 0.95, band: 95 }] : []),
  ];
  let band: PressureBand = 0;
  for (const candidate of pressureBands) {
    if (ratio >= candidate.threshold) {
      band = candidate.band;
    }
  }
  return band;
}

interface CheckSessionContextPressureParams {
  sessionEntry: SessionEntry;
  sessionKey: string;
  contextPressureThreshold: number | undefined;
  contextWindowTokens: number;
  earlyWarningBand?: number;
  postCompaction?: boolean;
}

interface CheckTokenContextPressureParams {
  sessionKey: string;
  totalTokens: number;
  contextWindow: number;
  threshold: number;
  earlyWarningBand?: number;
  postCompaction?: boolean;
}

interface CheckContextPressureResult {
  fired: boolean;
  band: PressureBand;
}

function buildContextPressureEvent(params: {
  percentUsed: number;
  tokensK: number;
  windowK: number;
  band: PressureBand;
  postCompaction?: boolean;
}): string {
  if (params.postCompaction) {
    return (
      `[system:context-pressure] Post-compaction: ${params.percentUsed}% context consumed ` +
      `(${params.tokensK}k/${params.windowK}k tokens). ` +
      `Session was compacted. Working state may need rehydration.`
    );
  }

  const urgency =
    params.band >= 95
      ? "COMPACTION IMMINENT — FIRST stage working-state survival via continue_delegate(mode='post-compaction', task='<working-state-summary>'), THEN call request_compaction(reason='<why>') volitionally; the alternative is forced compaction at absolute context exhaustion. " +
        "The post-compaction delegate is what carries state across the seam — if you call request_compaction without staging it first, working state will NOT survive. " +
        "Both are tool calls you can make right now, this turn."
      : params.band >= 90
        ? "Context window nearly full — FIRST stage working-state survival via continue_delegate(mode='post-compaction', task='...'), THEN call request_compaction(reason='...') volitionally; the alternative is forced compaction at absolute context exhaustion. " +
          "The post-compaction delegate fires after compaction completes and returns elective working-state to the new session — it is what carries state across the seam."
        : "Consider continue_delegate(mode='post-compaction', task='...') to stage working-state survival for upcoming compaction, or write critical state to memory files.";

  return (
    `[system:context-pressure] ${params.percentUsed}% of context window consumed ` +
    `(${params.tokensK}k / ${params.windowK}k tokens). ${urgency}`
  );
}

function checkSessionContextPressure(
  params: CheckSessionContextPressureParams,
): CheckContextPressureResult {
  const {
    sessionEntry,
    sessionKey,
    contextPressureThreshold,
    contextWindowTokens,
    earlyWarningBand,
    postCompaction = false,
  } = params;
  const threshold =
    contextPressureThreshold ?? (postCompaction ? DEFAULT_CONTEXT_PRESSURE_THRESHOLD : undefined);

  if (
    threshold == null ||
    threshold <= 0 ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0 ||
    sessionEntry.totalTokens == null ||
    !Number.isFinite(sessionEntry.totalTokens) ||
    sessionEntry.totalTokens <= 0 ||
    (!postCompaction && sessionEntry.totalTokensFresh === false)
  ) {
    return { fired: false, band: 0 };
  }

  const ratio = Math.max(0, sessionEntry.totalTokens / contextWindowTokens);
  const band = resolveContextPressureBand(ratio, threshold, earlyWarningBand);
  if (!postCompaction && band === 0 && ratio < threshold) {
    if (log.isEnabled("debug")) {
      log.debug(
        `[context-pressure:noop] reason=below-threshold ratio=${Math.round(ratio * 100)}% threshold=${Math.round(threshold * 100)}% rawRatio=${ratio.toFixed(4)} rawThreshold=${threshold.toFixed(4)} session=${sessionKey}`,
      );
    }
    return { fired: false, band: 0 };
  }

  const previous = sessionEntry.lastContextPressureBand;
  if (!postCompaction && previous !== undefined && band === previous) {
    if (log.isEnabled("debug")) {
      log.debug(
        `[context-pressure:noop] reason=band-dedup band=${band} previous=${previous} ratio=${Math.round(ratio * 100)}% session=${sessionKey}`,
      );
    }
    return { fired: false, band };
  }

  const percentUsed = Math.round(ratio * 100);
  const tokensK = Math.round(sessionEntry.totalTokens / 1000);
  const windowK = Math.round(contextWindowTokens / 1000);
  const eventText = buildContextPressureEvent({
    percentUsed,
    tokensK,
    windowK,
    band,
    postCompaction,
  });

  const logMessage = `[context-pressure:fire]${postCompaction ? " post-compaction" : ""} band=${band} previous=${previous ?? "none"} ratio=${percentUsed}% tokens=${tokensK}k/${windowK}k session=${sessionKey}`;
  if (postCompaction) {
    log.info(logMessage);
  } else {
    log.warn(logMessage);
  }

  enqueueSystemEvent(eventText, { sessionKey, trusted: true });
  sessionEntry.lastContextPressureBand = band;
  return { fired: true, band };
}

function checkTokenContextPressure(params: CheckTokenContextPressureParams): string | null {
  const {
    sessionKey,
    totalTokens,
    contextWindow,
    threshold,
    earlyWarningBand,
    postCompaction = false,
  } = params;

  if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(totalTokens)) {
    if (log.isEnabled("debug")) {
      log.debug(
        `[context-pressure:noop] reason=window-zero contextWindow=${contextWindow} session=${sessionKey}`,
      );
    }
    return null;
  }

  const ratio = totalTokens / contextWindow;
  const percentUsed = Math.round(ratio * 100);

  if (postCompaction) {
    const band = resolveContextPressureBand(ratio, threshold, earlyWarningBand);
    lastFiredBand.set(sessionKey, band);
    const eventText = buildContextPressureEvent({
      percentUsed,
      tokensK: Math.round(totalTokens / 1000),
      windowK: Math.round(contextWindow / 1000),
      band,
      postCompaction: true,
    });
    log.info(
      `[context-pressure:fire] post-compaction band=${band} ratio=${percentUsed}% session=${sessionKey}`,
    );
    return eventText;
  }

  const band = resolveContextPressureBand(ratio, threshold, earlyWarningBand);

  if (band === 0 && ratio < threshold) {
    if (log.isEnabled("debug")) {
      log.debug(
        `[context-pressure:noop] reason=below-threshold ratio=${percentUsed}% threshold=${Math.round(threshold * 100)}% rawRatio=${ratio.toFixed(4)} rawThreshold=${threshold.toFixed(4)} session=${sessionKey}`,
      );
    }
    return null;
  }

  const previous = lastFiredBand.get(sessionKey);
  const isFirstFire = previous === undefined;
  if (!isFirstFire && band === previous) {
    if (log.isEnabled("debug")) {
      log.debug(
        `[context-pressure:noop] reason=band-dedup band=${band} previous=${previous} ratio=${percentUsed}% session=${sessionKey}`,
      );
    }
    return null;
  }

  lastFiredBand.set(sessionKey, band);

  const eventText = buildContextPressureEvent({
    percentUsed,
    tokensK: Math.round(totalTokens / 1000),
    windowK: Math.round(contextWindow / 1000),
    band,
  });

  log.info(
    `[context-pressure:fire] band=${band} previous=${previous ?? "none"} ratio=${percentUsed}% session=${sessionKey}`,
  );

  return eventText;
}

/**
 * Check whether a context-pressure event should fire for the given session.
 *
 * Session-entry callers get the reply-pipeline result shape and event enqueueing.
 * Token callers get event text for lifecycle helpers that enqueue separately.
 */
export function checkContextPressure(
  params: CheckSessionContextPressureParams,
): CheckContextPressureResult;
export function checkContextPressure(params: CheckTokenContextPressureParams): string | null;
export function checkContextPressure(
  params: CheckSessionContextPressureParams | CheckTokenContextPressureParams,
): CheckContextPressureResult | string | null {
  if ("sessionEntry" in params) {
    return checkSessionContextPressure(params);
  }
  return checkTokenContextPressure(params);
}

/**
 * Clear pressure dedup state for a session. Call after compaction completes
 * so the post-compaction lifecycle can fire fresh bands.
 */
export function clearContextPressureState(sessionKey: string): void {
  lastFiredBand.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetContextPressureForTests(): void {
  lastFiredBand.clear();
}
