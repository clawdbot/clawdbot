import { renderCaptureDetailView } from "./ui-render-capture-detail.js";
import { captureEventGlyph, captureEventKey } from "./ui-render-capture-events.js";
import { renderCaptureStartupInstructions } from "./ui-render-capture-format.js";
import type { CaptureViewModel } from "./ui-render-capture-model.js";
import { redactCapturePayloadPreview } from "./ui-render-capture-redaction.js";
import { renderCaptureTimeline } from "./ui-render-capture-timeline.js";
import { esc, formatTime } from "./ui-render-utils.js";
import type { CaptureEventView } from "./ui-types.js";

export function renderCaptureWorkspace(model: CaptureViewModel): string {
  const {
    state,
    rows,
    events,
    filteredEvents,
    analysisEnabled,
    selectedEvent,
    pairedEventKey,
    groupedEvents,
    clusterEventBursts,
    availableDetailViews,
    effectiveDetailView,
  } = model;
  return `  <div class="results-view"${analysisEnabled ? ' style="grid-template-columns: minmax(420px, 1.7fr) minmax(280px, 0.9fr);"' : ""}>
    <div class="results-inspector">
      <div
        class="capture-body capture-body--detail-${state.captureDetailPlacement}"
        data-capture-detail-split-root
        style="--capture-detail-pane-width:${state.captureDetailSplitPct.toFixed(2)}%;"
      >
        <section class="capture-main-panel">
          <div class="inspector-section-title">${state.captureViewMode === "timeline" ? "Timeline" : "Recent Events"}</div>
          <div class="events-scroll capture-events-scroll">
            ${
              events.length === 0
                ? `<div style="padding:20px">${renderCaptureStartupInstructions(state.captureStartupStatus)}</div>`
                : filteredEvents.length === 0
                  ? '<div class="empty-state" style="padding:20px">No events match the current filters or search text.</div>'
                  : state.captureViewMode === "timeline"
                    ? renderCaptureTimeline(model)
                    : groupedEvents
                        .map((group) => {
                          const groupMeta = [
                            `${group.events.length} event${group.events.length === 1 ? "" : "s"}`,
                            group.meta,
                          ]
                            .filter(Boolean)
                            .join(" · ");
                          const rowsLocal =
                            state.captureGroupMode === "burst"
                              ? clusterEventBursts(group.events)
                                  .map((cluster) => {
                                    const event = cluster.representative;
                                    const key = cluster.key;
                                    const selected =
                                      selectedEvent != null &&
                                      key === captureEventKey(selectedEvent);
                                    const paired = pairedEventKey != null && key === pairedEventKey;
                                    const glyph = captureEventGlyph(event);
                                    return `
                                    <button class="capture-event-card capture-event-card-compact${selected ? " selected" : ""}${paired ? " paired" : ""}" data-capture-event="${esc(key)}" type="button">
                                      <div class="capture-event-card-rail">
                                        <span class="capture-glyph capture-glyph-${glyph.cls}">${esc(glyph.label)}</span>
                                      </div>
                                      <div class="capture-event-card-body">
                                        <div class="capture-event-card-header">
                                          <div class="capture-event-card-title-row">
                                            <strong>${esc(event.host || event.provider || event.kind)}</strong>
                                            <span class="text-dimmed text-sm">${esc(
                                              [event.method, event.path]
                                                .filter(Boolean)
                                                .join(" ") || event.kind,
                                            )}</span>
                                          </div>
                                          <div class="capture-event-card-meta-row">
                                            <span class="text-dimmed text-sm">${cluster.count} events</span>
                                            <span class="text-dimmed text-sm">${esc(formatTime(cluster.startTs))} → ${esc(formatTime(cluster.endTs))}</span>
                                            ${event.status ? `<span class="text-dimmed text-sm">status ${event.status}</span>` : ""}
                                          </div>
                                        </div>
                                        ${
                                          event.provider || event.model
                                            ? `<div class="text-dimmed text-sm">${esc(
                                                [event.provider, event.model]
                                                  .filter(Boolean)
                                                  .join(" · "),
                                              )}</div>`
                                            : ""
                                        }
                                        ${paired ? '<div class="capture-pair-badge">paired counterpart</div>' : ""}
                                        ${
                                          event.payloadPreview
                                            ? `<div class="capture-event-card-preview">${esc(
                                                redactCapturePayloadPreview(event.payloadPreview),
                                              )}</div>`
                                            : ""
                                        }
                                      </div>
                                    </button>`;
                                  })
                                  .join("")
                              : group.events
                                  .map((event: CaptureEventView) => {
                                    const key = captureEventKey(event);
                                    const selected =
                                      selectedEvent != null &&
                                      key === captureEventKey(selectedEvent);
                                    const paired = pairedEventKey != null && key === pairedEventKey;
                                    const glyph = captureEventGlyph(event);
                                    return `
                              <button class="capture-event-card capture-event-card-compact${selected ? " selected" : ""}${paired ? " paired" : ""}" data-capture-event="${esc(key)}" type="button">
                                <div class="capture-event-card-rail">
                                  <span class="capture-glyph capture-glyph-${glyph.cls}">${esc(glyph.label)}</span>
                                </div>
                                <div class="capture-event-card-body">
                                  <div class="capture-event-card-header">
                                    <div class="capture-event-card-title-row">
                                      <strong>${esc(event.host || event.provider || event.kind)}</strong>
                                      <span class="text-dimmed text-sm">${esc(
                                        [event.method, event.path].filter(Boolean).join(" ") ||
                                          event.kind,
                                      )}</span>
                                    </div>
                                    <div class="capture-event-card-meta-row">
                                      <span class="text-dimmed text-sm">${esc(new Date(event.ts).toLocaleTimeString())}</span>
                                      ${event.status ? `<span class="text-dimmed text-sm">status ${event.status}</span>` : ""}
                                      ${event.closeCode ? `<span class="text-dimmed text-sm">close ${event.closeCode}</span>` : ""}
                                      <span class="text-dimmed text-sm">${esc(event.direction)} · ${esc(event.protocol)}</span>
                                    </div>
                                  </div>
                                ${paired ? '<div class="capture-pair-badge">paired counterpart</div>' : ""}
                                ${
                                  event.provider || event.api || event.captureOrigin
                                    ? `<div class="text-dimmed text-sm">${esc(
                                        [event.provider, event.api, event.captureOrigin]
                                          .filter(Boolean)
                                          .join(" · "),
                                      )}</div>`
                                    : ""
                                }
                                ${
                                  event.payloadPreview
                                    ? `<div class="capture-event-card-preview">${esc(
                                        redactCapturePayloadPreview(event.payloadPreview),
                                      )}</div>`
                                    : ""
                                }
                                ${event.errorText ? `<div class="capture-error" style="margin-top:8px">${esc(event.errorText)}</div>` : ""}
                                </div>
                              </button>`;
                                  })
                                  .join("");
                          return state.captureGroupMode === "none"
                            ? rowsLocal
                            : `<section class="capture-group">
                              <div class="capture-group-header">
                                <div class="capture-group-title">${esc(group.label)}</div>
                                <div class="capture-group-meta">${esc(groupMeta)}</div>
                              </div>
                              ${rowsLocal}
                            </section>`;
                        })
                        .join("")
            }
          </div>
        </section>
        ${
          state.captureDetailPlacement === "right"
            ? `<div class="capture-detail-splitter${state.captureDetailSplitDragging ? " dragging" : ""}" data-capture-detail-splitter role="separator" aria-orientation="vertical" aria-label="Resize detail pane">
                <span class="capture-detail-splitter-label">${Math.round(state.captureDetailSplitPct)}%</span>
              </div>`
            : ""
        }
        <aside class="capture-detail-pane">
          <div class="inspector-section-title">Selected Event</div>
          ${
            selectedEvent == null
              ? '<div class="empty-state">Select an event to inspect its details.</div>'
              : `
              <div class="capture-detail-card">
                <div class="capture-detail-view-switch" role="radiogroup" aria-label="Detail view">
                  ${availableDetailViews
                    .filter((view) => view.available)
                    .map(
                      (view) => `<label class="capture-detail-view-option">
                        <input type="radio" name="capture-detail-view" value="${view.value}"${
                          effectiveDetailView === view.value ? " checked" : ""
                        } />
                        <span>${view.label}${view.recommended ? ' <em class="capture-detail-view-hint">recommended</em>' : ""}</span>
                      </label>`,
                    )
                    .join("")}
                </div>
                <div class="capture-detail-meta">
                  <span class="capture-chip">${esc(selectedEvent.kind)}</span>
                  <span class="capture-chip">${esc(selectedEvent.direction)}</span>
                  <span class="capture-chip">${esc(selectedEvent.protocol)}</span>
                  ${selectedEvent.provider ? `<span class="capture-chip">${esc(selectedEvent.provider)}</span>` : ""}
                  ${selectedEvent.api ? `<span class="capture-chip">${esc(selectedEvent.api)}</span>` : ""}
                  ${selectedEvent.model ? `<span class="capture-chip">${esc(selectedEvent.model)}</span>` : ""}
                  ${selectedEvent.status ? `<span class="capture-chip">status ${selectedEvent.status}</span>` : ""}
                  ${selectedEvent.closeCode ? `<span class="capture-chip">close ${selectedEvent.closeCode}</span>` : ""}
                </div>
                <div class="capture-detail-view-body">
                  ${renderCaptureDetailView(model)}
                </div>
              </div>`
          }
        </aside>
      </div>
    </div>
    <div class="results-sidebar"${analysisEnabled ? "" : ' style="display:none"'}>
      <div class="inspector-section-title">Analysis Results</div>
      <div class="text-dimmed text-sm" style="margin-bottom:10px">
        ${
          analysisEnabled
            ? `Preset: ${esc(state.captureQueryPreset)}`
            : "Analysis disabled. Select a preset to group the raw events."
        }
      </div>
      <div class="events-scroll" style="max-height: 520px">
        ${
          rows.length === 0
            ? '<div class="empty-state" style="padding:20px">This session has raw traffic, but nothing matched the selected analysis preset.</div>'
            : rows
                .map(
                  (row) =>
                    `<pre class="report-pre" style="margin:0 0 10px 0">${esc(JSON.stringify(row, null, 2))}</pre>`,
                )
                .join("")
        }
      </div>
    </div>
  </div>`;
}
