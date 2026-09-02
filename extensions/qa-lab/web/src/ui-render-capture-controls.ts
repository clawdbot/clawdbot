import type { CaptureViewModel } from "./ui-render-capture-model.js";
import { esc } from "./ui-render-utils.js";
import type { CaptureQueryPreset } from "./ui-types.js";

export function renderCaptureControls(model: CaptureViewModel): string {
  const {
    state,
    sessionIds,
    sessions,
    availableKinds,
    availableProviders,
    availableHosts,
    activeFilters,
    activeWindowStartPct,
    draftWindowStartPct,
    selectedSessions,
    selectedEvent,
  } = model;
  return `  <div class="capture-controls-shell">
    <div class="capture-controls-toolbar">
      <div class="capture-controls-summary">
        <span class="capture-chip capture-chip-muted">${selectedSessions.length || 0} session${selectedSessions.length === 1 ? "" : "s"}</span>
        <span class="capture-chip capture-chip-muted">${state.captureViewMode}</span>
        ${
          state.captureQueryPreset !== "none"
            ? `<span class="capture-chip capture-chip-muted">analysis: ${esc(state.captureQueryPreset)}</span>`
            : `<span class="capture-chip capture-chip-muted">raw only</span>`
        }
        <span class="capture-chip capture-chip-muted">${activeFilters.length} filter${activeFilters.length === 1 ? "" : "s"}</span>
        ${
          state.captureViewMode === "timeline"
            ? `<span class="capture-chip capture-chip-muted">lanes: ${esc(state.captureTimelineLaneMode)}</span>`
            : ""
        }
      </div>
      <div class="capture-controls-actions">
        ${
          selectedSessions.length > 0
            ? `<button class="btn-sm" type="button" id="capture-summary-toggle">
                ${state.captureSummaryExpanded ? "Hide summary" : "Show summary"}
              </button>`
            : ""
        }
        ${
          activeFilters.length > 0
            ? `<button
                id="capture-clear-filters"
                class="secondary-button capture-clear-filters"
                type="button"
              >Clear filters</button>`
            : ""
        }
        <button class="btn-sm" type="button" id="capture-controls-toggle">
          ${state.captureControlsExpanded ? "Collapse controls" : "Show controls"}
        </button>
      </div>
    </div>
    ${
      state.captureControlsExpanded
        ? `<div class="capture-controls-panel">
  <div class="capture-controls-grid">
    <label class="capture-session-filter">Session
      <select id="capture-session" multiple size="${Math.min(3, Math.max(2, sessions.length || 2))}">
        ${sessions
          .map(
            (session) =>
              `<option value="${esc(session.id)}"${
                sessionIds.includes(session.id) ? " selected" : ""
              }>${esc(new Date(session.startedAt).toLocaleString())} · ${esc(session.mode)} · ${session.eventCount} events</option>`,
          )
          .join("")}
      </select>
    </label>
    <div class="capture-inline-actions">
      <label class="capture-saved-view-filter">Saved view
        <select id="capture-saved-view">
          <option value="">apply saved view…</option>
          ${state.captureSavedViews
            .map((view) => `<option value="${esc(view.id)}">${esc(view.name)}</option>`)
            .join("")}
        </select>
      </label>
      <button id="capture-save-view" class="btn-sm" type="button">Save view</button>
      <button
        id="capture-delete-view"
        class="btn-sm"
        type="button"${state.captureSavedViews.length === 0 ? " disabled" : ""}
      >Delete view</button>
    </div>
    ${
      selectedSessions.length > 0
        ? `<div class="capture-selected-sessions-shell">
            <div class="capture-selected-sessions-summary">
              <span class="capture-chip capture-chip-muted">${selectedSessions.length} selected</span>
              ${
                selectedSessions.length > 1
                  ? `<button
                      id="capture-toggle-selected-sessions"
                      class="btn-sm"
                      type="button"
                    >${state.captureSelectedSessionsExpanded ? "Hide selected" : "Manage selected"}</button>`
                  : ""
              }
            </div>
            ${
              state.captureSelectedSessionsExpanded || selectedSessions.length === 1
                ? `<div class="capture-selected-sessions">
                    ${selectedSessions
                      .map(
                        (session) => `<button
                          type="button"
                          class="capture-selected-session-chip"
                          data-capture-session-remove="${esc(session.id)}"
                          title="Remove ${esc(new Date(session.startedAt).toLocaleString())}"
                        >
                          <span class="capture-selected-session-chip-label">${esc(new Date(session.startedAt).toLocaleString())}</span>
                          <span class="capture-selected-session-chip-x">×</span>
                        </button>`,
                      )
                      .join("")}
                  </div>`
                : ""
            }
          </div>`
        : ""
    }
    <div class="capture-inline-actions">
      <button
        id="capture-delete-selected-sessions"
        class="btn-sm"
        type="button"${selectedSessions.length === 0 ? " disabled" : ""}
      >Delete selected data</button>
      <button
        id="capture-purge-all"
        class="btn-sm"
        type="button"${sessions.length === 0 ? " disabled" : ""}
      >Purge all data</button>
    </div>
    <label>Analysis
      <select id="capture-preset">
        ${(
          [
            "none",
            "double-sends",
            "retry-storms",
            "cache-busting",
            "ws-duplicate-frames",
            "missing-ack",
            "error-bursts",
          ] as CaptureQueryPreset[]
        )
          .map(
            (preset) =>
              `<option value="${preset}"${
                preset === state.captureQueryPreset ? " selected" : ""
              }>${preset === "none" ? "none (show raw events only)" : preset}</option>`,
          )
          .join("")}
      </select>
    </label>
    <label>Kind
      <select id="capture-kind-filter" multiple size="${Math.min(6, Math.max(3, availableKinds.length || 3))}">
        ${availableKinds
          .map(
            (kind) =>
              `<option value="${esc(kind)}"${
                state.captureKindFilter.includes(kind) ? " selected" : ""
              }>${esc(kind)}</option>`,
          )
          .join("")}
      </select>
    </label>
    <label>Provider
      <select id="capture-provider-filter" multiple size="${Math.min(6, Math.max(3, availableProviders.length || 3))}">
        ${availableProviders
          .map(
            (provider) =>
              `<option value="${esc(provider)}"${
                state.captureProviderFilter.includes(provider) ? " selected" : ""
              }>${esc(provider)}</option>`,
          )
          .join("")}
      </select>
    </label>
    <label>Host
      <select id="capture-host-filter" multiple size="${Math.min(6, Math.max(3, availableHosts.length || 3))}">
        ${availableHosts
          .map(
            (host) =>
              `<option value="${esc(host)}"${
                state.captureHostFilter.includes(host) ? " selected" : ""
              }>${esc(host)}</option>`,
          )
          .join("")}
      </select>
    </label>
    <label>View
      <select id="capture-view-mode">
        <option value="list"${state.captureViewMode === "list" ? " selected" : ""}>list</option>
        <option value="timeline"${state.captureViewMode === "timeline" ? " selected" : ""}>timeline</option>
      </select>
    </label>
    ${
      state.captureViewMode === "timeline"
        ? `
    <label>Timeline Lanes
      <select id="capture-timeline-lane-mode">
        <option value="domain"${state.captureTimelineLaneMode === "domain" ? " selected" : ""}>domain</option>
        <option value="provider"${state.captureTimelineLaneMode === "provider" ? " selected" : ""}>provider</option>
        <option value="flow"${state.captureTimelineLaneMode === "flow" ? " selected" : ""}>flow</option>
      </select>
    </label>
    <label>Lane Sort
      <select id="capture-timeline-lane-sort">
        <option value="most-events"${state.captureTimelineLaneSort === "most-events" ? " selected" : ""}>most events</option>
        <option value="most-errors"${state.captureTimelineLaneSort === "most-errors" ? " selected" : ""}>most errors</option>
        <option value="severity"${state.captureTimelineLaneSort === "severity" ? " selected" : ""}>severity</option>
        <option value="alphabetical"${state.captureTimelineLaneSort === "alphabetical" ? " selected" : ""}>alphabetical</option>
      </select>
    </label>
    <label class="capture-search-field">Lane Search
      <input
        id="capture-timeline-lane-search"
        type="search"
        value="${esc(state.captureTimelineLaneSearch)}"
        placeholder="provider, host, flow..."
        spellcheck="false"
      />
    </label>
    <label>Timeline Zoom
      <select id="capture-timeline-zoom">
        <option value="75"${state.captureTimelineZoom === 75 ? " selected" : ""}>75%</option>
        <option value="100"${state.captureTimelineZoom === 100 ? " selected" : ""}>100%</option>
        <option value="150"${state.captureTimelineZoom === 150 ? " selected" : ""}>150%</option>
        <option value="200"${state.captureTimelineZoom === 200 ? " selected" : ""}>200%</option>
        <option value="300"${state.captureTimelineZoom === 300 ? " selected" : ""}>300%</option>
      </select>
    </label>
    <label>Sparkline
      <select id="capture-timeline-sparkline-mode">
        <option value="session-relative"${state.captureTimelineSparklineMode === "session-relative" ? " selected" : ""}>session-relative</option>
        <option value="lane-relative"${state.captureTimelineSparklineMode === "lane-relative" ? " selected" : ""}>lane-relative</option>
      </select>
    </label>
    <button
      id="capture-timeline-clear-window"
      class="secondary-button capture-clear-filters"
      type="button"${activeWindowStartPct == null && draftWindowStartPct == null ? " disabled" : ""}
    >Clear window</button>
    <label class="capture-checkbox">
      <input
        id="capture-timeline-focus-flow"
        type="checkbox"${
          state.captureTimelineFocusSelectedFlow ? " checked" : ""
        }${selectedEvent?.flowId ? "" : " disabled"}
      />
      <span>focus selected flow</span>
    </label>
    <label>Focused Lanes
      <select id="capture-timeline-focused-lane-mode"${state.captureTimelineFocusSelectedFlow && selectedEvent?.flowId ? "" : " disabled"}>
        <option value="all"${state.captureTimelineFocusedLaneMode === "all" ? " selected" : ""}>show all</option>
        <option value="only-matching"${state.captureTimelineFocusedLaneMode === "only-matching" ? " selected" : ""}>only matching</option>
        <option value="collapse-background"${state.captureTimelineFocusedLaneMode === "collapse-background" ? " selected" : ""}>collapse background</option>
      </select>
    </label>
    <label>Focus Threshold
      <select id="capture-timeline-focused-lane-threshold"${state.captureTimelineFocusSelectedFlow && selectedEvent?.flowId ? "" : " disabled"}>
        <option value="any"${state.captureTimelineFocusedLaneThreshold === "any" ? " selected" : ""}>any presence</option>
        <option value="events-2"${state.captureTimelineFocusedLaneThreshold === "events-2" ? " selected" : ""}>2+ events</option>
        <option value="percent-10"${state.captureTimelineFocusedLaneThreshold === "percent-10" ? " selected" : ""}>10%+ of lane</option>
        <option value="percent-25"${state.captureTimelineFocusedLaneThreshold === "percent-25" ? " selected" : ""}>25%+ of lane</option>
      </select>
    </label>`
        : `
    <label>Group
      <select id="capture-group-mode">
        <option value="none"${state.captureGroupMode === "none" ? " selected" : ""}>flat stream</option>
        <option value="burst"${state.captureGroupMode === "burst" ? " selected" : ""}>burst clusters</option>
        <option value="flow"${state.captureGroupMode === "flow" ? " selected" : ""}>flow id</option>
        <option value="host-path"${state.captureGroupMode === "host-path" ? " selected" : ""}>host + path</option>
      </select>
    </label>`
    }
    <label>Detail Pane
      <select id="capture-detail-placement">
        <option value="right"${state.captureDetailPlacement === "right" ? " selected" : ""}>right</option>
        <option value="bottom"${state.captureDetailPlacement === "bottom" ? " selected" : ""}>bottom</option>
      </select>
    </label>
    <label>Headers
      <select id="capture-header-mode">
        <option value="key"${state.captureHeaderMode === "key" ? " selected" : ""}>key only</option>
        <option value="all"${state.captureHeaderMode === "all" ? " selected" : ""}>all</option>
        <option value="hidden"${state.captureHeaderMode === "hidden" ? " selected" : ""}>hidden</option>
      </select>
    </label>
    <label class="capture-search-field">Search
      <input
        id="capture-search-filter"
        type="search"
        value="${esc(state.captureSearchText)}"
        placeholder="host, path, method, status, payload..."
        spellcheck="false"
      />
    </label>
    <label class="capture-checkbox">
      <input id="capture-errors-only" type="checkbox"${state.captureErrorsOnly ? " checked" : ""} />
      <span>errors only</span>
    </label>
  </div></div>`
        : ""
    }
  </div>
  ${
    state.captureControlsExpanded && activeFilters.length > 0
      ? `<div class="capture-active-filters">
          <span class="capture-summary-label" style="margin:0">Active Filters</span>
          <div class="capture-chip-row">
            ${activeFilters.map((filter) => `<span class="capture-chip capture-chip-muted">${esc(filter)}</span>`).join("")}
          </div>
        </div>`
      : ""
  }
`;
}
