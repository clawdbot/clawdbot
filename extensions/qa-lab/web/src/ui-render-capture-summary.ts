import type { CaptureViewModel } from "./ui-render-capture-model.js";
import { esc } from "./ui-render-utils.js";

export function renderCaptureSummary(model: CaptureViewModel): string {
  const {
    state,
    sessionIds,
    selectedSessions,
    singleSelectedSession,
    selectedSessionEventCount,
    topKinds,
    topProviders,
    topModels,
    summaryChips,
    summaryMeta,
  } = model;
  return `  ${
    selectedSessions.length > 0 && state.captureSummaryExpanded
      ? `<div class="capture-summary capture-summary--expanded">
          <div class="capture-summary-card">
            <div class="capture-summary-label">Session</div>
            <div class="capture-summary-value">${
              singleSelectedSession
                ? esc(new Date(singleSelectedSession.startedAt).toLocaleString())
                : `${selectedSessions.length} sessions selected`
            }</div>
            <div class="text-dimmed text-sm">${
              singleSelectedSession
                ? `${esc(singleSelectedSession.mode)} · ${singleSelectedSession.eventCount} stored events`
                : `${selectedSessionEventCount} stored events across ${selectedSessions.length} sessions`
            }</div>
          </div>
          <div class="capture-summary-card">
            <div class="capture-summary-label">What You’re Seeing</div>
            <div class="capture-chip-row">
              ${summaryChips.map((chip) => `<span class="capture-chip">${esc(chip)}</span>`).join("")}
            </div>
            ${
              summaryMeta.length > 0
                ? `<div class="capture-summary-meta text-dimmed text-sm">${summaryMeta.map((part) => esc(part)).join(" · ")}</div>`
                : ""
            }
            ${
              state.captureQueryPreset !== "none" && sessionIds.length > 1
                ? '<div class="capture-summary-note text-dimmed text-sm">Analysis presets currently run on a single session only. Raw traffic below is merged across the selected sessions.</div>'
                : ""
            }
            ${
              state.captureViewMode === "timeline"
                ? '<div class="capture-summary-note text-dimmed text-sm">Keys: 1-4 views · ←/→ markers · Home/End jump · Esc clears brush · drag sparkline bins · Shift+drag widens.</div>'
                : ""
            }
          </div>
          <div class="capture-summary-card">
            <div class="capture-summary-label">Visible Event Kinds</div>
            <div class="capture-chip-row">
              ${
                topKinds.length > 0
                  ? topKinds
                      .map(
                        ([kind, count]) =>
                          `<span class="capture-chip">${esc(kind)} · ${count}</span>`,
                      )
                      .join("")
                  : '<span class="text-dimmed text-sm">No events match the current filters.</span>'
              }
            </div>
          </div>
          <div class="capture-summary-card">
            <div class="capture-summary-label">Observed Providers</div>
            <div class="capture-chip-row">
              ${
                topProviders.length > 0
                  ? topProviders
                      .map(
                        (provider) =>
                          `<span class="capture-chip">${esc(provider.value)} · ${provider.count}</span>`,
                      )
                      .join("")
                  : '<span class="text-dimmed text-sm">No provider metadata captured for this session yet.</span>'
              }
            </div>
            ${
              topModels.length > 0
                ? `<div class="capture-summary-meta text-dimmed text-sm">Top models: ${topModels
                    .map((topModel) => `${esc(topModel.value)} (${topModel.count})`)
                    .join(", ")}</div>`
                : ""
            }
            ${
              state.captureCoverage
                ? `<div class="capture-summary-meta text-dimmed text-sm">${state.captureCoverage.totalEvents} total events · ${state.captureCoverage.unlabeledEventCount} unlabeled by provider/model/api</div>`
                : ""
            }
          </div>
        </div>`
      : ""
  }
`;
}
