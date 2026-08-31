import { captureEventKey } from "./ui-render-capture-events.js";
import type { CaptureViewModel } from "./ui-render-capture-model.js";
import { redactCapturePayloadPreview } from "./ui-render-capture-redaction.js";
import { esc, formatTime } from "./ui-render-utils.js";

export function renderCaptureTimeline(model: CaptureViewModel): string {
  const {
    state,
    minTs,
    totalSpanMs,
    activeWindowStartPct,
    activeWindowEndPct,
    draftWindowStartPct,
    draftWindowEndPct,
    selectedEvent,
    selectedEventKey,
    pairedEventKey,
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
  } = model;
  return `<div class="capture-timeline" style="${timelineWidthStyle}">
                    <div class="capture-timeline-legend">
                      <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-dot capture-timeline-legend-dot-request"></span>request</span>
                      <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-dot capture-timeline-legend-dot-response"></span>response</span>
                      <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-dot capture-timeline-legend-dot-error"></span>error</span>
                      <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-dot capture-timeline-legend-dot-ws"></span>ws</span>
                      <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-line"></span>flow trail</span>
                      ${
                        activeWindowStartPct != null && activeWindowEndPct != null
                          ? '<span class="capture-timeline-legend-item"><span class="capture-timeline-legend-window"></span>active window</span>'
                          : ""
                      }
                    </div>
                    <div class="capture-timeline-axis-grid">
                      <div class="capture-timeline-axis-spacer"></div>
                      <div class="capture-timeline-viewport capture-timeline-brush-surface" data-capture-timeline-brush-surface="axis" data-capture-timeline-track-width="${timelineTrackWidthPx}">
                        <div class="capture-timeline-axis">
                          ${renderTimelineWindow(activeWindowStartPct, activeWindowEndPct, "capture-timeline-window")}
                          ${renderTimelineWindow(draftWindowStartPct, draftWindowEndPct, "capture-timeline-window capture-timeline-window-draft")}
                          ${timelineAxisTicks
                            .map(
                              (
                                tick,
                              ) => `<div class="capture-timeline-axis-tick ${tick.edgeClass}" style="left:${tick.pct.toFixed(2)}%">
                                <span class="capture-timeline-axis-tick-line"></span>
                                <span class="capture-timeline-axis-tick-label">${esc(tick.label)}</span>
                              </div>`,
                            )
                            .join("")}
                        </div>
                      </div>
                    </div>
                    ${
                      visibleTimelineLanes.length === 0
                        ? '<div class="empty-state" style="padding:20px">No timeline lanes match the current lane search.</div>'
                        : visibleTimelineLanes
                            .map((lane) => {
                              const laneErrorCount = lane.events.filter(
                                (event) => Boolean(event.errorText) || (event.status ?? 0) >= 400,
                              ).length;
                              const laneRequestCount = lane.events.filter(
                                (event) => event.kind === "request",
                              ).length;
                              const laneResponseCount = lane.events.filter(
                                (event) => event.kind === "response",
                              ).length;
                              const collapsed = collapsedLaneIds.has(lane.id);
                              const pinned = pinnedLaneIds.has(lane.id);
                              const sortedLaneEvents = [...lane.events].toSorted(
                                (left, right) => left.ts - right.ts,
                              );
                              const markerGapPx = 16;
                              const rowStridePx = 18;
                              const baselineTopPx = 18;
                              const rowRightEdges: number[] = [];
                              const packedMarkers = sortedLaneEvents.map((event) => {
                                const key = captureEventKey(event);
                                const leftPct = ((event.ts - minTs) / totalSpanMs) * 100;
                                const leftPx = (leftPct / 100) * timelineTrackWidthPx;
                                let rowIndex = 0;
                                while (rowIndex < rowRightEdges.length) {
                                  const rowRightEdge = rowRightEdges[rowIndex];
                                  if (
                                    rowRightEdge === undefined ||
                                    rowRightEdge <= leftPx - markerGapPx
                                  ) {
                                    break;
                                  }
                                  rowIndex += 1;
                                }
                                rowRightEdges[rowIndex] = leftPx + markerGapPx;
                                const topPx = baselineTopPx + rowIndex * rowStridePx;
                                return { event, key, leftPct, leftPx, rowIndex, topPx };
                              });
                              const laneRowCount = Math.max(
                                1,
                                packedMarkers.reduce(
                                  (max, marker) => Math.max(max, marker.rowIndex + 1),
                                  1,
                                ),
                              );
                              const laneTrackHeightPx = collapsed
                                ? 18
                                : Math.max(
                                    42,
                                    baselineTopPx + (laneRowCount - 1) * rowStridePx + 18,
                                  );
                              const selectedLaneEvent =
                                lane.events.find((event) => {
                                  const key = captureEventKey(event);
                                  return key === selectedEventKey;
                                }) ?? null;
                              const selectedFlowIdLocal =
                                selectedLaneEvent?.flowId || selectedEvent?.flowId || "";
                              const focusSelectedFlow =
                                state.captureTimelineFocusSelectedFlow &&
                                selectedFlowIdLocal.length > 0;
                              const laneFocusedEventCount = focusSelectedFlow
                                ? lane.events.filter(
                                    (event) => event.flowId === selectedFlowIdLocal,
                                  ).length
                                : 0;
                              const laneBackgroundEventCount = focusSelectedFlow
                                ? lane.events.length - laneFocusedEventCount
                                : 0;
                              const laneFocusedPercent =
                                focusSelectedFlow && lane.events.length > 0
                                  ? Math.round((laneFocusedEventCount / lane.events.length) * 100)
                                  : 0;
                              const laneSelected = selectedLaneEvent != null;
                              const laneSeverity = describeLaneSeverity(lane.events);
                              const laneMeetsThreshold = focusSelectedFlow
                                ? laneMeetsFocusedThreshold(
                                    laneFocusedEventCount,
                                    lane.events.length,
                                  )
                                : false;
                              const autoCollapsed =
                                focusSelectedFlow &&
                                focusedLaneMode === "collapse-background" &&
                                !laneMeetsThreshold;
                              const laneCompactMetaParts = [
                                focusSelectedFlow
                                  ? `${laneFocusedPercent}% focus${laneBackgroundEventCount > 0 ? ` · ${laneBackgroundEventCount} bg` : ""}`
                                  : null,
                                laneErrorCount > 0 ? `${laneErrorCount} err` : null,
                                state.captureTimelineLaneSort === "severity"
                                  ? laneSeverity.summary
                                  : null,
                                autoCollapsed ? "auto-collapsed" : null,
                              ].filter((value): value is string => Boolean(value));
                              const previousIndex = previousLanePosition.get(lane.id);
                              const currentIndex = timelineLanes.findIndex(
                                (candidate) => candidate.id === lane.id,
                              );
                              const laneMovement =
                                previousIndex == null ? null : previousIndex - currentIndex;
                              const laneIsCollapsed = collapsed || autoCollapsed;
                              const flowLinks = laneIsCollapsed
                                ? ""
                                : Array.from(
                                    packedMarkers.reduce<Map<string, typeof packedMarkers>>(
                                      (flows, marker) => {
                                        const flowId = marker.event.flowId?.trim();
                                        if (!flowId) {
                                          return flows;
                                        }
                                        const existing = flows.get(flowId) ?? [];
                                        existing.push(marker);
                                        flows.set(flowId, existing);
                                        return flows;
                                      },
                                      new Map(),
                                    ),
                                  )
                                    .flatMap(([, markers]) => {
                                      if (markers.length < 2) {
                                        return [];
                                      }
                                      const followingMarkers = markers.slice(1).values();
                                      return markers.slice(0, -1).flatMap((previous) => {
                                        const following = followingMarkers.next();
                                        if (following.done) {
                                          return [];
                                        }
                                        const marker = following.value;
                                        const dx = marker.leftPx - previous.leftPx;
                                        const dy = marker.topPx - previous.topPx;
                                        const length = Math.sqrt(dx * dx + dy * dy);
                                        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                                        const selected =
                                          selectedFlowIdLocal.length > 0 &&
                                          marker.event.flowId === selectedFlowIdLocal;
                                        const dimmed =
                                          focusSelectedFlow &&
                                          marker.event.flowId !== selectedFlowIdLocal;
                                        const paired =
                                          pairedEventKey != null &&
                                          captureEventKey(marker.event) === pairedEventKey;
                                        return [
                                          `<div
                                    class="capture-timeline-flow-link${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}${paired ? " paired" : ""}"
                                    style="left:${previous.leftPct.toFixed(2)}%;top:${previous.topPx}px;width:${length.toFixed(2)}px;transform:translateY(-50%) rotate(${angle.toFixed(2)}deg)"
                                  ></div>`,
                                        ];
                                      });
                                    })
                                    .join("");
                              const laneGuides = timelineAxisTicks
                                .slice(1, -1)
                                .map(
                                  (tick) => `<div
                              class="capture-timeline-guide"
                              style="left:${tick.pct.toFixed(2)}%"
                              aria-hidden="true"
                            ></div>`,
                                )
                                .join("");
                              const markers = packedMarkers
                                .map(({ event, key, leftPct, topPx }) => {
                                  const selected =
                                    selectedEventKey != null && key === selectedEventKey;
                                  const kindClass = `capture-timeline-marker-${event.kind.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
                                  const dimmed =
                                    focusSelectedFlow && event.flowId !== selectedFlowIdLocal;
                                  const paired = pairedEventKey != null && key === pairedEventKey;
                                  const label = [
                                    formatTime(event.ts),
                                    event.provider,
                                    event.model,
                                    event.kind,
                                    event.method,
                                    event.host,
                                    event.path,
                                    event.status ? `status ${event.status}` : "",
                                    event.errorText ?? "",
                                  ]
                                    .filter(Boolean)
                                    .join(" · ");
                                  return `<button
                              class="capture-timeline-marker ${kindClass}${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}${paired ? " paired" : ""}"
                              data-capture-event="${esc(key)}"
                              type="button"
                              style="left:${leftPct.toFixed(2)}%;top:${topPx}px"
                              title="${esc(label)}"
                            ></button>`;
                                })
                                .join("");
                              const collapsedMarkers = laneIsCollapsed
                                ? packedMarkers
                                    .map(({ event, key, leftPct }) => {
                                      const selected =
                                        selectedEventKey != null && key === selectedEventKey;
                                      const kindClass = `capture-timeline-marker-${event.kind
                                        .replace(/[^a-z0-9]+/gi, "-")
                                        .toLowerCase()}`;
                                      const dimmed =
                                        focusSelectedFlow && event.flowId !== selectedFlowIdLocal;
                                      const paired =
                                        pairedEventKey != null && key === pairedEventKey;
                                      return `<button
                                  class="capture-timeline-marker capture-timeline-marker-mini ${kindClass}${
                                    selected ? " selected" : ""
                                  }${dimmed ? " dimmed" : ""}${paired ? " paired" : ""}"
                                  data-capture-event="${esc(key)}"
                                  type="button"
                                  style="left:${leftPct.toFixed(2)}%;top:${baselineTopPx}px"
                                  title="${esc(
                                    [formatTime(event.ts), event.kind, event.host, event.path]
                                      .filter(Boolean)
                                      .join(" · "),
                                  )}"
                                ></button>`;
                                    })
                                    .join("")
                                : "";
                              const selectedLaneLeft =
                                selectedLaneEvent == null
                                  ? 50
                                  : Math.min(
                                      84,
                                      Math.max(
                                        16,
                                        ((selectedLaneEvent.ts - minTs) / totalSpanMs) * 100,
                                      ),
                                    );
                              const quickPreview =
                                selectedLaneEvent && !laneIsCollapsed
                                  ? `<div class="capture-timeline-quick-preview" style="left:${selectedLaneLeft.toFixed(2)}%">
                                <div class="capture-timeline-quick-preview-row">
                                  <span class="capture-chip">${esc(selectedLaneEvent.kind)}</span>
                                  ${
                                    selectedLaneEvent.provider
                                      ? `<span class="capture-chip">${esc(selectedLaneEvent.provider)}</span>`
                                      : ""
                                  }
                                  ${
                                    selectedLaneEvent.status
                                      ? `<span class="capture-chip capture-chip-muted">status ${selectedLaneEvent.status}</span>`
                                      : ""
                                  }
                                </div>
                                <div class="capture-timeline-quick-preview-title">${esc(
                                  [
                                    selectedLaneEvent.method,
                                    selectedLaneEvent.host,
                                    selectedLaneEvent.path,
                                  ]
                                    .filter(Boolean)
                                    .join(" ") || selectedLaneEvent.flowId,
                                )}</div>
                                <div class="capture-timeline-quick-preview-meta">${esc(
                                  [
                                    new Date(selectedLaneEvent.ts).toLocaleTimeString(),
                                    selectedLaneEvent.model,
                                    selectedLaneEvent.api,
                                  ]
                                    .filter(Boolean)
                                    .join(" · "),
                                )}</div>
                                ${
                                  selectedLaneEvent.errorText
                                    ? `<div class="capture-timeline-quick-preview-error">${esc(selectedLaneEvent.errorText)}</div>`
                                    : selectedLaneEvent.payloadPreview
                                      ? `<div class="capture-timeline-quick-preview-snippet">${esc(
                                          redactCapturePayloadPreview(
                                            selectedLaneEvent.payloadPreview,
                                          ),
                                        )}</div>`
                                      : ""
                                }
                              </div>`
                                  : "";
                              return `<div class="capture-timeline-lane${laneSelected ? " selected" : ""}">
                            <div class="capture-timeline-lane-label${laneSelected ? " selected" : ""}">
                              <div class="capture-timeline-lane-toolbar">
                                <button class="capture-timeline-lane-toggle" data-capture-lane-toggle="${esc(lane.id)}" type="button">
                                  <span class="capture-timeline-lane-chevron">${laneIsCollapsed ? "▸" : "▾"}</span>
                                  <span class="capture-timeline-lane-title">${esc(lane.label)}</span>
                                </button>
                                <button class="capture-timeline-lane-pin${pinned ? " pinned" : ""}" data-capture-lane-pin="${esc(lane.id)}" type="button" title="${pinned ? "Unpin lane" : "Pin lane"}">
                                  ${pinned ? "★" : "☆"}
                                </button>
                              </div>
                              <div class="capture-timeline-lane-meta">${lane.events.length} event${lane.events.length === 1 ? "" : "s"}${
                                lane.meta ? ` · ${esc(lane.meta)}` : ""
                              }</div>
                              ${
                                focusSelectedFlow && laneSelected
                                  ? `<div class="capture-timeline-lane-focus-meta">
                                      <span class="capture-mono">${esc(selectedFlowIdLocal)}</span>
                                      <span>·</span>
                                      <span>${laneFocusedEventCount}/${lane.events.length} events focused</span>
                                      <span>·</span>
                                      <span>${laneFocusedPercent}% of lane</span>
                                      ${
                                        laneBackgroundEventCount > 0
                                          ? `<span>·</span><span>${laneBackgroundEventCount} background</span>`
                                          : ""
                                      }
                                      ${
                                        focusSelectedFlow && !laneMeetsThreshold
                                          ? `<span>·</span><span>below threshold</span>`
                                          : ""
                                      }
                                    </div>`
                                  : ""
                              }
                              ${
                                autoCollapsed && laneSelected
                                  ? '<div class="capture-timeline-lane-meta">Auto-collapsed because the focused flow is not present in this lane.</div>'
                                  : ""
                              }
                              ${
                                !laneSelected && laneCompactMetaParts.length > 0
                                  ? `<div class="capture-timeline-lane-compact-meta">${esc(laneCompactMetaParts.join(" · "))}</div>`
                                  : ""
                              }
                              ${renderLaneSparkline(lane.events, lane.id)}
                              <div class="capture-timeline-lane-stats">
                                <span class="capture-timeline-stat" title="requests">
                                  <span class="capture-timeline-stat-key capture-timeline-stat-key-request">R</span>
                                  <span class="capture-timeline-stat-value">${laneRequestCount}</span>
                                </span>
                                <span class="capture-timeline-stat" title="responses">
                                  <span class="capture-timeline-stat-key capture-timeline-stat-key-response">S</span>
                                  <span class="capture-timeline-stat-value">${laneResponseCount}</span>
                                </span>
                                ${
                                  laneMovement == null || laneMovement === 0
                                    ? ""
                                    : `<span class="capture-chip capture-chip-movement capture-timeline-inline-chip ${
                                        laneMovement > 0 ? "up" : "down"
                                      }">${laneMovement > 0 ? `up ${laneMovement}` : `down ${Math.abs(laneMovement)}`}</span>`
                                }
                                ${
                                  state.captureTimelineLaneSort === "severity"
                                    ? `<span class="capture-chip capture-chip-severity capture-timeline-inline-chip">severity ${laneSeverity.score.toFixed(1)}</span>`
                                    : ""
                                }
                                ${
                                  focusSelectedFlow
                                    ? `<span class="capture-timeline-stat" title="focused flow events">
                                        <span class="capture-timeline-stat-key capture-timeline-stat-key-focus">F</span>
                                        <span class="capture-timeline-stat-value">${laneFocusedEventCount}</span>
                                      </span>`
                                    : ""
                                }
                                ${
                                  focusSelectedFlow && laneBackgroundEventCount > 0
                                    ? `<span class="capture-timeline-stat" title="background events">
                                        <span class="capture-timeline-stat-key capture-timeline-stat-key-background">B</span>
                                        <span class="capture-timeline-stat-value">${laneBackgroundEventCount}</span>
                                      </span>`
                                    : ""
                                }
                                ${
                                  laneErrorCount > 0
                                    ? `<span class="capture-timeline-stat capture-timeline-stat-danger" title="errors">
                                        <span class="capture-timeline-stat-key capture-timeline-stat-key-error">!</span>
                                        <span class="capture-timeline-stat-value">${laneErrorCount}</span>
                                      </span>`
                                    : ""
                                }
                              </div>
                              ${
                                laneSelected &&
                                (state.captureTimelineLaneSort === "severity" ||
                                  laneMovement != null)
                                  ? `<div class="capture-timeline-lane-severity">${
                                      laneMovement == null || laneMovement === 0
                                        ? ""
                                        : `<span class="capture-timeline-lane-movement-copy">${
                                            laneMovement > 0
                                              ? `Moved up ${laneMovement} from ${state.captureTimelinePreviousLaneSort}`
                                              : `Moved down ${Math.abs(laneMovement)} from ${state.captureTimelinePreviousLaneSort}`
                                          }</span>${
                                            state.captureTimelineLaneSort === "severity"
                                              ? " · "
                                              : ""
                                          }`
                                    }${
                                      state.captureTimelineLaneSort === "severity"
                                        ? esc(laneSeverity.summary)
                                        : ""
                                    }</div>`
                                  : ""
                              }
                            </div>
                            <div class="capture-timeline-viewport">
                              <div class="capture-timeline-lane-track${laneIsCollapsed ? " collapsed" : ""}${laneSelected ? " selected" : ""}" style="height:${laneTrackHeightPx}px">
                                ${renderTimelineWindow(activeWindowStartPct, activeWindowEndPct, "capture-timeline-window")}
                                ${renderTimelineWindow(draftWindowStartPct, draftWindowEndPct, "capture-timeline-window capture-timeline-window-draft")}
                                ${laneGuides}
                                <div class="capture-timeline-track-line" style="top:${baselineTopPx}px"></div>
                                ${flowLinks}
                                ${quickPreview}
                                ${laneIsCollapsed ? collapsedMarkers : markers}
                              </div>
                            </div>
                          </div>`;
                            })
                            .join("")
                    }
                  </div>`;
}
