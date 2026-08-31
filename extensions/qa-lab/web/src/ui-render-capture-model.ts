import { captureEventKey, findPairedCaptureEvent } from "./ui-render-capture-events.js";
import { renderCapturePayload } from "./ui-render-capture-format.js";
import {
  isSensitiveCaptureField,
  redactCapturePayloadPreview,
} from "./ui-render-capture-redaction.js";
import { buildCaptureTimelineModel } from "./ui-render-capture-timeline-model.js";
import { esc, formatDuration, formatTime, parseJsonObject } from "./ui-render-utils.js";
import type { CaptureEventView, UiState } from "./ui-types.js";

export function buildCaptureViewModel(state: UiState) {
  const sessionIds =
    state.selectedCaptureSessionIds.length > 0
      ? state.selectedCaptureSessionIds
      : state.captureSessions[0]?.id
        ? [state.captureSessions[0].id]
        : [];
  const sessions = state.captureSessions;
  const rows = state.captureQueryRows;
  const events = state.captureEvents;
  const availableKinds = [
    ...new Set(
      events.map((event) => event.kind).filter((value): value is string => Boolean(value)),
    ),
  ].toSorted();
  const availableProviders = [
    ...new Set(
      events.map((event) => event.provider).filter((value): value is string => Boolean(value)),
    ),
  ].toSorted();
  const availableHosts = [
    ...new Set(
      events.map((event) => event.host).filter((value): value is string => Boolean(value)),
    ),
  ].toSorted();
  const normalizedSearch = state.captureSearchText.trim().toLowerCase();
  const activeFilters: string[] = [];
  if (state.captureKindFilter.length > 0) {
    activeFilters.push(`kind: ${state.captureKindFilter.join(", ")}`);
  }
  if (state.captureProviderFilter.length > 0) {
    activeFilters.push(`provider: ${state.captureProviderFilter.join(", ")}`);
  }
  if (state.captureHostFilter.length > 0) {
    activeFilters.push(`host: ${state.captureHostFilter.join(", ")}`);
  }
  if (normalizedSearch) {
    activeFilters.push(`search: ${state.captureSearchText.trim()}`);
  }
  if (state.captureHeaderMode !== "key") {
    activeFilters.push(`headers: ${state.captureHeaderMode}`);
  }
  if (state.captureViewMode === "list" && state.captureGroupMode !== "none") {
    activeFilters.push(`group: ${state.captureGroupMode}`);
  }
  if (state.captureViewMode === "timeline") {
    activeFilters.push(`lanes: ${state.captureTimelineLaneMode}`);
    activeFilters.push(`lane sort: ${state.captureTimelineLaneSort}`);
    activeFilters.push(`zoom: ${state.captureTimelineZoom}%`);
    if (state.captureTimelineFocusSelectedFlow) {
      activeFilters.push("focus selected flow");
      if (state.captureTimelineFocusedLaneMode !== "all") {
        activeFilters.push(`focused lanes: ${state.captureTimelineFocusedLaneMode}`);
      }
      if (state.captureTimelineFocusedLaneThreshold !== "any") {
        activeFilters.push(`focus threshold: ${state.captureTimelineFocusedLaneThreshold}`);
      }
    }
    if (state.captureTimelineLaneSearch.trim()) {
      activeFilters.push(`lane search: ${state.captureTimelineLaneSearch.trim()}`);
    }
    if (state.capturePinnedLaneIds.length > 0) {
      activeFilters.push(`pinned lanes: ${state.capturePinnedLaneIds.length}`);
    }
    if (state.captureTimelineSparklineMode !== "session-relative") {
      activeFilters.push(`sparkline: ${state.captureTimelineSparklineMode}`);
    }
  }
  if (state.captureErrorsOnly) {
    activeFilters.push("errors only");
  }
  const baseFilteredEvents = events.filter((event) => {
    if (state.captureKindFilter.length > 0 && !state.captureKindFilter.includes(event.kind)) {
      return false;
    }
    if (
      state.captureProviderFilter.length > 0 &&
      !state.captureProviderFilter.includes(event.provider || "")
    ) {
      return false;
    }
    if (state.captureHostFilter.length > 0 && !state.captureHostFilter.includes(event.host || "")) {
      return false;
    }
    if (state.captureErrorsOnly && !event.errorText && (event.status ?? 0) < 400) {
      return false;
    }
    if (normalizedSearch) {
      const haystack = [
        event.kind,
        event.protocol,
        event.direction,
        event.provider,
        event.api,
        event.model,
        event.method,
        event.host,
        event.path,
        event.status == null ? "" : String(event.status),
        event.errorText,
        event.payloadPreview,
        event.flowId,
        event.closeCode == null ? "" : String(event.closeCode),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }
    return true;
  });
  const minTs =
    baseFilteredEvents.length > 0 ? Math.min(...baseFilteredEvents.map((event) => event.ts)) : 0;
  const maxTs =
    baseFilteredEvents.length > 0 ? Math.max(...baseFilteredEvents.map((event) => event.ts)) : 0;
  const totalSpanMs = Math.max(1, maxTs - minTs);
  const activeWindowStartPct =
    state.captureTimelineWindowStartPct != null && state.captureTimelineWindowEndPct != null
      ? Math.min(state.captureTimelineWindowStartPct, state.captureTimelineWindowEndPct)
      : null;
  const activeWindowEndPct =
    state.captureTimelineWindowStartPct != null && state.captureTimelineWindowEndPct != null
      ? Math.max(state.captureTimelineWindowStartPct, state.captureTimelineWindowEndPct)
      : null;
  const draftWindowStartPct =
    state.captureTimelineBrushAnchorPct != null && state.captureTimelineBrushCurrentPct != null
      ? Math.min(state.captureTimelineBrushAnchorPct, state.captureTimelineBrushCurrentPct)
      : null;
  const draftWindowEndPct =
    state.captureTimelineBrushAnchorPct != null && state.captureTimelineBrushCurrentPct != null
      ? Math.max(state.captureTimelineBrushAnchorPct, state.captureTimelineBrushCurrentPct)
      : null;
  const activeWindowStartTs =
    activeWindowStartPct == null ? null : minTs + totalSpanMs * (activeWindowStartPct / 100);
  const activeWindowEndTs =
    activeWindowEndPct == null ? null : minTs + totalSpanMs * (activeWindowEndPct / 100);
  const activeWindowLabel =
    activeWindowStartTs == null || activeWindowEndTs == null
      ? null
      : `${formatTime(activeWindowStartTs)} → ${formatTime(activeWindowEndTs)} · ${formatDuration(
          Math.max(0, activeWindowEndTs - activeWindowStartTs),
        )}`;
  if (activeWindowLabel && state.captureViewMode === "timeline") {
    activeFilters.push(`window: ${activeWindowLabel}`);
  }
  const filteredEvents =
    state.captureViewMode === "timeline" &&
    activeWindowStartPct != null &&
    activeWindowEndPct != null
      ? baseFilteredEvents.filter((event) => {
          const percent = ((event.ts - minTs) / totalSpanMs) * 100;
          return percent >= activeWindowStartPct && percent <= activeWindowEndPct;
        })
      : baseFilteredEvents;
  const analysisEnabled = state.captureQueryPreset !== "none";
  const selectedSessions = sessions.filter((session) => sessionIds.includes(session.id));
  const singleSelectedSession =
    selectedSessions.length === 1 ? (selectedSessions[0] ?? null) : null;
  const selectedSessionEventCount = selectedSessions.reduce(
    (sum, session) => sum + session.eventCount,
    0,
  );
  const selectedEvent =
    filteredEvents.find((event) => {
      const key = captureEventKey(event);
      return key === state.selectedCaptureEventKey;
    }) ??
    filteredEvents[0] ??
    null;
  const selectedEventKey = selectedEvent == null ? null : captureEventKey(selectedEvent);
  const kindCounts = new Map<string, number>();
  for (const event of filteredEvents) {
    kindCounts.set(event.kind, (kindCounts.get(event.kind) ?? 0) + 1);
  }
  const topKinds = [...kindCounts.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 4);
  const topProviders = state.captureCoverage?.providers.slice(0, 4) ?? [];
  const topModels = state.captureCoverage?.models.slice(0, 3) ?? [];
  const selectedFlowId = selectedEvent?.flowId?.trim() || "";
  const selectedFlowEvents =
    selectedFlowId.length > 0
      ? events
          .filter((event) => event.flowId === selectedFlowId)
          .toSorted(
            (left, right) =>
              left.ts - right.ts || captureEventKey(left).localeCompare(captureEventKey(right)),
          )
      : [];
  const selectedFlowIndex =
    selectedEvent == null
      ? -1
      : selectedFlowEvents.findIndex(
          (event) => captureEventKey(event) === captureEventKey(selectedEvent),
        );
  const previousFlowEvent =
    selectedFlowIndex > 0 ? selectedFlowEvents[selectedFlowIndex - 1] : null;
  const nextFlowEvent =
    selectedFlowIndex >= 0 && selectedFlowIndex < selectedFlowEvents.length - 1
      ? selectedFlowEvents[selectedFlowIndex + 1]
      : null;
  const selectedPairing = findPairedCaptureEvent(selectedEvent, events);
  const pairedEvent = selectedPairing.counterpart;
  const pairedEventKey = pairedEvent ? captureEventKey(pairedEvent) : null;
  const pairedEventVisible =
    pairedEventKey != null &&
    filteredEvents.some((event) => captureEventKey(event) === pairedEventKey);
  const pairingLatencyMs =
    selectedEvent && pairedEvent ? Math.max(0, Math.abs(pairedEvent.ts - selectedEvent.ts)) : null;
  const previousFlowEventVisible =
    previousFlowEvent != null &&
    filteredEvents.some((event) => captureEventKey(event) === captureEventKey(previousFlowEvent));
  const nextFlowEventVisible =
    nextFlowEvent != null &&
    filteredEvents.some((event) => captureEventKey(event) === captureEventKey(nextFlowEvent));
  const timeline = buildCaptureTimelineModel({
    state,
    filteredEvents,
    selectedFlowId,
    minTs,
    maxTs,
    totalSpanMs,
  });
  const { pinnedLaneIds, timelineLanes, visibleTimelineLanes } = timeline;
  const summaryChips = [
    sessionIds.length > 1 ? `sessions: ${sessionIds.length}` : null,
    analysisEnabled ? `analysis: ${state.captureQueryPreset}` : "raw only",
    state.captureViewMode === "timeline"
      ? `timeline: ${state.captureTimelineLaneMode}`
      : "view: list",
    state.captureViewMode === "timeline" ? `sort: ${state.captureTimelineLaneSort}` : null,
    state.captureViewMode === "timeline" ? `zoom: ${state.captureTimelineZoom}%` : null,
    activeFilters.length > 0 ? `filters: ${activeFilters.length}` : null,
    normalizedSearch ? `search` : null,
  ].filter((value): value is string => Boolean(value));
  const summaryMeta = [
    `${filteredEvents.length} visible`,
    selectedSessions.length > 0 ? `${selectedSessionEventCount} stored` : null,
    state.captureViewMode === "timeline" && activeWindowLabel
      ? `window ${activeWindowLabel}`
      : null,
    state.captureViewMode === "timeline"
      ? `${visibleTimelineLanes.length}/${timelineLanes.length} lanes${pinnedLaneIds.size > 0 ? ` · ${pinnedLaneIds.size} pinned` : ""}`
      : null,
    state.captureTimelineFocusSelectedFlow && selectedEvent?.flowId
      ? `focus ${selectedEvent.flowId}`
      : null,
  ].filter((value): value is string => Boolean(value));
  const groupedEvents =
    state.captureGroupMode === "none" || state.captureGroupMode === "burst"
      ? [{ id: "__all__", label: "All Events", meta: "", events: filteredEvents }]
      : Array.from(
          filteredEvents.reduce((groups, event) => {
            const key =
              state.captureGroupMode === "flow"
                ? event.flowId || "(no flow)"
                : [event.host || "(no host)", event.path || "/"].join(" ");
            const label =
              state.captureGroupMode === "flow"
                ? event.flowId || "(no flow id)"
                : [event.host || "(no host)", event.path || "/"].join(" ");
            const existing = groups.get(key);
            if (existing) {
              existing.events.push(event);
              return groups;
            }
            groups.set(key, {
              id: key,
              label,
              meta:
                state.captureGroupMode === "flow"
                  ? [event.host, event.path].filter(Boolean).join(" ")
                  : event.flowId || "",
              events: [event],
            });
            return groups;
          }, new Map()),
        ).map(([, group]) => group);
  const clusterEventBursts = (eventsForGroup: CaptureEventView[]) => {
    const sorted = [...eventsForGroup].toSorted(
      (left, right) =>
        left.ts - right.ts || captureEventKey(left).localeCompare(captureEventKey(right)),
    );
    const clusters: Array<{
      key: string;
      representative: CaptureEventView;
      events: CaptureEventView[];
      count: number;
      startTs: number;
      endTs: number;
    }> = [];
    for (const event of sorted) {
      const previous = clusters.at(-1);
      const sameShape =
        previous &&
        previous.representative.kind === event.kind &&
        previous.representative.direction === event.direction &&
        (previous.representative.provider || "") === (event.provider || "") &&
        (previous.representative.host || "") === (event.host || "") &&
        (previous.representative.path || "") === (event.path || "") &&
        (previous.representative.method || "") === (event.method || "") &&
        (previous.representative.status || 0) === (event.status || 0) &&
        event.ts - previous.endTs <= 1500;
      if (!sameShape) {
        clusters.push({
          key: captureEventKey(event),
          representative: event,
          events: [event],
          count: 1,
          startTs: event.ts,
          endTs: event.ts,
        });
        continue;
      }
      previous.events.push(event);
      previous.count += 1;
      previous.endTs = event.ts;
      previous.representative = event;
    }
    return clusters;
  };
  const selectedHeaders = parseJsonObject(selectedEvent?.headersJson);
  const selectedHeaderCount = selectedHeaders ? Object.keys(selectedHeaders).length : 0;
  const selectedSensitiveHeaderCount = selectedHeaders
    ? Object.keys(selectedHeaders).filter((label) => isSensitiveCaptureField(label)).length
    : 0;
  const selectedPayload = renderCapturePayload(
    selectedEvent?.dataText,
    selectedEvent?.contentType,
    {
      payloadEventSort: state.capturePayloadEventSort,
      payloadEventFilter: state.capturePayloadEventFilter,
    },
  );
  const selectedMetaRows = selectedEvent
    ? [
        { label: "provider", value: selectedEvent.provider ?? "unlabeled" },
        { label: "model", value: selectedEvent.model ?? "n/a" },
        { label: "api", value: selectedEvent.api ?? "n/a" },
        { label: "peer host", value: selectedEvent.host ?? "n/a" },
        { label: "path", value: selectedEvent.path ?? "n/a" },
        { label: "flow id", value: selectedEvent.flowId },
        { label: "capture origin", value: selectedEvent.captureOrigin ?? "runtime/default" },
        { label: "content-type", value: selectedEvent.contentType ?? "n/a" },
      ].filter((row) => row.value.trim().length > 0)
    : [];
  const rawPayloadBody = selectedEvent?.dataText?.length
    ? `<pre class="report-pre capture-pre">${esc(
        redactCapturePayloadPreview(selectedEvent.dataText),
      )}</pre>`
    : '<div class="empty-state">No inline payload preview for this event.</div>';
  const availableDetailViews: Array<{
    value: UiState["captureDetailView"];
    label: string;
    available: boolean;
    recommended: boolean;
  }> = [
    { value: "overview", label: "Overview", available: true, recommended: false },
    {
      value: "flow",
      label: "Flow",
      available: selectedFlowEvents.length > 0 || pairedEvent != null,
      recommended:
        (selectedEvent?.kind === "request" || selectedEvent?.kind === "response") &&
        (selectedFlowEvents.length > 1 || pairedEvent != null),
    },
    {
      value: "payload",
      label: "Payload",
      available: Boolean(selectedEvent?.dataText?.length || selectedEvent?.dataBlobId),
      recommended: selectedPayload.byteLength > 0,
    },
    {
      value: "headers",
      label: "Headers",
      available: selectedHeaderCount > 0,
      recommended: !selectedPayload.byteLength && selectedHeaderCount > 0,
    },
  ];
  if (!availableDetailViews.some((view) => view.recommended && view.available)) {
    const overviewView = availableDetailViews.find((view) => view.value === "overview");
    if (overviewView) {
      overviewView.recommended = true;
    }
  }
  const preferredDetailView = state.capturePreferredDetailView;
  const effectiveDetailView = availableDetailViews.some(
    (view) => view.value === preferredDetailView && view.available,
  )
    ? (preferredDetailView ?? "overview")
    : availableDetailViews.some((view) => view.value === state.captureDetailView && view.available)
      ? state.captureDetailView
      : (availableDetailViews.find((view) => view.recommended && view.available)?.value ??
        "overview");
  const effectiveFlowLayout =
    state.captureFlowDetailLayout ??
    ((selectedEvent?.kind === "request" || selectedEvent?.kind === "response") && pairedEvent
      ? "pair-first"
      : "nav-first");
  const effectivePayloadLayout =
    state.capturePayloadDetailLayout ?? (selectedPayload.looksStructured ? "formatted" : "raw");
  const effectivePayloadExtent = state.capturePayloadExtent;
  return {
    state,
    sessionIds,
    sessions,
    rows,
    events,
    availableKinds,
    availableProviders,
    availableHosts,
    normalizedSearch,
    activeFilters,
    baseFilteredEvents,
    minTs,
    maxTs,
    totalSpanMs,
    activeWindowStartPct,
    activeWindowEndPct,
    draftWindowStartPct,
    draftWindowEndPct,
    activeWindowStartTs,
    activeWindowEndTs,
    activeWindowLabel,
    filteredEvents,
    analysisEnabled,
    selectedSessions,
    singleSelectedSession,
    selectedSessionEventCount,
    selectedEvent,
    selectedEventKey,
    kindCounts,
    topKinds,
    topProviders,
    topModels,
    selectedFlowId,
    selectedFlowEvents,
    selectedFlowIndex,
    previousFlowEvent,
    nextFlowEvent,
    selectedPairing,
    pairedEvent,
    pairedEventKey,
    pairedEventVisible,
    pairingLatencyMs,
    previousFlowEventVisible,
    nextFlowEventVisible,
    ...timeline,
    summaryChips,
    summaryMeta,
    groupedEvents,
    clusterEventBursts,
    selectedHeaders,
    selectedHeaderCount,
    selectedSensitiveHeaderCount,
    selectedPayload,
    selectedMetaRows,
    rawPayloadBody,
    availableDetailViews,
    preferredDetailView,
    effectiveDetailView,
    effectiveFlowLayout,
    effectivePayloadLayout,
    effectivePayloadExtent,
  };
}

export type CaptureViewModel = ReturnType<typeof buildCaptureViewModel>;
