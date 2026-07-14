import { esc, formatTime } from "./ui-render-utils.js";
import type { CaptureEventView, UiState } from "./ui-types.js";

export function buildCaptureTimelineModel(params: {
  state: UiState;
  filteredEvents: CaptureEventView[];
  selectedFlowId: string;
  minTs: number;
  maxTs: number;
  totalSpanMs: number;
}) {
  const { filteredEvents, maxTs, minTs, selectedFlowId, state, totalSpanMs } = params;
  const timelineTrackWidthPx = Math.round(960 * (state.captureTimelineZoom / 100));
  const timelineWidthStyle = `--capture-timeline-track-width:${timelineTrackWidthPx}px`;
  const renderTimelineWindow = (
    startPct: number | null,
    endPct: number | null,
    className: string,
  ): string => {
    if (startPct == null || endPct == null) {
      return "";
    }
    const left = Math.max(0, Math.min(100, startPct));
    const width = Math.max(0, Math.min(100, endPct) - left);
    return `<div class="${className}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></div>`;
  };
  const timelineAxisTicks = Array.from({ length: 5 }, (_, index) => {
    const pct = (index / 4) * 100;
    const ts = minTs + (totalSpanMs * pct) / 100;
    return {
      pct,
      label: formatTime(ts),
      edgeClass:
        index === 0
          ? "capture-timeline-axis-tick-start"
          : index === 4
            ? "capture-timeline-axis-tick-end"
            : "",
    };
  });
  const renderLaneSparkline = (eventsForLane: CaptureEventView[], laneId: string) => {
    if (eventsForLane.length === 0) {
      return "";
    }
    const binCount = 18;
    const bins = Array.from({ length: binCount }, () => 0);
    const laneMinTs = eventsForLane.reduce(
      (min, event) => Math.min(min, event.ts),
      eventsForLane[0]?.ts ?? minTs,
    );
    const laneMaxTs = eventsForLane.reduce(
      (max, event) => Math.max(max, event.ts),
      eventsForLane[0]?.ts ?? maxTs,
    );
    const laneSpanMs = Math.max(1, laneMaxTs - laneMinTs);
    for (const event of eventsForLane) {
      const spanStart = state.captureTimelineSparklineMode === "lane-relative" ? laneMinTs : minTs;
      const spanMs =
        state.captureTimelineSparklineMode === "lane-relative" ? laneSpanMs : totalSpanMs;
      const rawIndex = spanMs <= 0 ? 0 : Math.floor(((event.ts - spanStart) / spanMs) * binCount);
      const index = Math.max(0, Math.min(binCount - 1, rawIndex));
      bins[index] = (bins[index] ?? 0) + 1;
    }
    const maxBin = Math.max(...bins, 1);
    return `<div class="capture-timeline-sparkline">
      ${bins
        .map((count, index) => {
          const height = Math.max(12, Math.round((count / maxBin) * 100));
          const spanStartTs =
            state.captureTimelineSparklineMode === "lane-relative"
              ? laneMinTs + (laneSpanMs * index) / binCount
              : minTs + (totalSpanMs * index) / binCount;
          const spanEndTs =
            state.captureTimelineSparklineMode === "lane-relative"
              ? laneMinTs + (laneSpanMs * (index + 1)) / binCount
              : minTs + (totalSpanMs * (index + 1)) / binCount;
          const startPct = ((spanStartTs - minTs) / Math.max(1, totalSpanMs)) * 100;
          const endPct = ((spanEndTs - minTs) / Math.max(1, totalSpanMs)) * 100;
          const binLabel = `${laneId} · ${formatTime(spanStartTs)} → ${formatTime(spanEndTs)} · ${count} events`;
          return `<button
            class="capture-timeline-sparkline-bar"
            data-capture-sparkline-window="${esc(laneId)}:${index}"
            data-capture-window-start="${startPct.toFixed(4)}"
            data-capture-window-end="${endPct.toFixed(4)}"
            type="button"
            title="${esc(`${binLabel} · click/drag: custom window · Shift+drag: wider context`)}"
            style="height:${height}%"
          ></button>`;
        })
        .join("")}
    </div>`;
  };
  const computeLaneSeverity = (eventsForLane: CaptureEventView[]) => {
    const total = eventsForLane.length;
    const errorCount = eventsForLane.filter(
      (event) => Boolean(event.errorText) || (event.status ?? 0) >= 400,
    ).length;
    const focusedCount = selectedFlowId
      ? eventsForLane.filter((event) => event.flowId === selectedFlowId).length
      : 0;
    const recencyScore =
      total === 0
        ? 0
        : eventsForLane.reduce((max, event) => Math.max(max, event.ts), 0) / Math.max(1, maxTs);
    const errorShare = total > 0 ? errorCount / total : 0;
    const focusedShare = total > 0 ? focusedCount / total : 0;
    return (
      errorCount * 10 +
      errorShare * 30 +
      focusedShare * 35 +
      recencyScore * 8 +
      Math.min(total, 40) * 0.2
    );
  };
  const describeLaneSeverity = (eventsForLane: CaptureEventView[]) => {
    const total = eventsForLane.length;
    const errorCount = eventsForLane.filter(
      (event) => Boolean(event.errorText) || (event.status ?? 0) >= 400,
    ).length;
    const focusedCount = selectedFlowId
      ? eventsForLane.filter((event) => event.flowId === selectedFlowId).length
      : 0;
    const newestTs =
      total === 0 ? 0 : eventsForLane.reduce((max, event) => Math.max(max, event.ts), 0);
    const recencyMinutes =
      newestTs > 0 ? Math.max(0, Math.round((maxTs - newestTs) / 60000)) : null;
    const focusedPercent = total > 0 ? Math.round((focusedCount / total) * 100) : 0;
    const errorPercent = total > 0 ? Math.round((errorCount / total) * 100) : 0;
    const reasons: string[] = [];
    if (errorCount > 0) {
      reasons.push(`${errorCount} errors (${errorPercent}%)`);
    }
    if (selectedFlowId && focusedCount > 0) {
      reasons.push(`focused flow ${focusedPercent}%`);
    }
    if (recencyMinutes != null) {
      reasons.push(recencyMinutes === 0 ? "active now" : `${recencyMinutes}m old`);
    }
    if (total > 0) {
      reasons.push(`${total} events`);
    }
    return {
      score: computeLaneSeverity(eventsForLane),
      summary: reasons.join(" · "),
    };
  };
  const unsortedTimelineLanes = Array.from(
    filteredEvents.reduce((lanes, event) => {
      const providerLabel = event.provider || "unlabeled";
      const flowLabel = event.flowId || "(no flow id)";
      const laneConfig =
        state.captureTimelineLaneMode === "provider"
          ? {
              id: providerLabel,
              label: providerLabel,
              meta: [event.host, event.api, event.model].filter(Boolean).join(" · "),
            }
          : state.captureTimelineLaneMode === "flow"
            ? {
                id: flowLabel,
                label: flowLabel,
                meta: [event.provider, event.host, event.path].filter(Boolean).join(" · "),
              }
            : {
                id: event.host || "(no host)",
                label: event.host || "(no host)",
                meta: [event.provider, event.model].filter(Boolean).join(", "),
              };
      const laneId = laneConfig.id;
      const existing = lanes.get(laneId);
      if (existing) {
        existing.events.push(event);
        return lanes;
      }
      lanes.set(laneId, {
        id: laneId,
        label: laneConfig.label,
        meta: laneConfig.meta,
        events: [event],
      });
      return lanes;
    }, new Map()),
  ).map(([, lane]) => lane);
  const sortTimelineLanes = (
    lanes: Array<{ id: string; label: string; meta: string; events: CaptureEventView[] }>,
    mode: UiState["captureTimelineLaneSort"],
  ) =>
    [...lanes].toSorted((a, b) => {
      const aErrorCount = a.events.filter(
        (event) => Boolean(event.errorText) || (event.status ?? 0) >= 400,
      ).length;
      const bErrorCount = b.events.filter(
        (event) => Boolean(event.errorText) || (event.status ?? 0) >= 400,
      ).length;
      if (mode === "severity") {
        return (
          computeLaneSeverity(b.events) - computeLaneSeverity(a.events) ||
          bErrorCount - aErrorCount ||
          b.events.length - a.events.length ||
          a.label.localeCompare(b.label)
        );
      }
      if (mode === "most-errors") {
        return (
          bErrorCount - aErrorCount ||
          b.events.length - a.events.length ||
          a.label.localeCompare(b.label)
        );
      }
      if (mode === "alphabetical") {
        return a.label.localeCompare(b.label);
      }
      return (
        b.events.length - a.events.length ||
        bErrorCount - aErrorCount ||
        a.label.localeCompare(b.label)
      );
    });
  const timelineLanes = sortTimelineLanes(unsortedTimelineLanes, state.captureTimelineLaneSort);
  const previousTimelineLanes =
    state.captureTimelinePreviousLaneSort == null
      ? null
      : sortTimelineLanes(unsortedTimelineLanes, state.captureTimelinePreviousLaneSort);
  const previousLanePosition = new Map<string, number>(
    (previousTimelineLanes ?? []).map((lane, index) => [lane.id, index]),
  );
  const laneSearch = state.captureTimelineLaneSearch.trim().toLowerCase();
  const collapsedLaneIds = new Set(state.captureCollapsedLaneIds);
  const pinnedLaneIds = new Set(state.capturePinnedLaneIds);
  const focusedLaneMode =
    state.captureTimelineFocusSelectedFlow && selectedFlowId
      ? state.captureTimelineFocusedLaneMode
      : "all";
  const focusedLaneThreshold =
    state.captureTimelineFocusSelectedFlow && selectedFlowId
      ? state.captureTimelineFocusedLaneThreshold
      : "any";
  const laneMeetsFocusedThreshold = (focusedCount: number, laneTotal: number) => {
    if (focusedLaneThreshold === "events-2") {
      return focusedCount >= 2;
    }
    if (focusedLaneThreshold === "percent-10") {
      return laneTotal > 0 && focusedCount / laneTotal >= 0.1;
    }
    if (focusedLaneThreshold === "percent-25") {
      return laneTotal > 0 && focusedCount / laneTotal >= 0.25;
    }
    return focusedCount > 0;
  };
  const visibleTimelineLanes = timelineLanes.filter((lane) => {
    const focusedCount = selectedFlowId
      ? lane.events.filter((event) => event.flowId === selectedFlowId).length
      : 0;
    if (
      focusedLaneMode === "only-matching" &&
      !laneMeetsFocusedThreshold(focusedCount, lane.events.length) &&
      !pinnedLaneIds.has(lane.id)
    ) {
      return false;
    }
    if (pinnedLaneIds.size > 0 && pinnedLaneIds.has(lane.id)) {
      return true;
    }
    if (!laneSearch) {
      return pinnedLaneIds.size === 0 || !pinnedLaneIds.has(lane.id);
    }
    const haystack = [lane.label, lane.meta].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(laneSearch);
  });
  return {
    timelineTrackWidthPx,
    timelineWidthStyle,
    renderTimelineWindow,
    timelineAxisTicks,
    renderLaneSparkline,
    describeLaneSeverity,
    timelineLanes,
    previousLanePosition,
    collapsedLaneIds,
    pinnedLaneIds,
    focusedLaneMode,
    laneMeetsFocusedThreshold,
    visibleTimelineLanes,
  };
}

export type CaptureTimelineModel = ReturnType<typeof buildCaptureTimelineModel>;
