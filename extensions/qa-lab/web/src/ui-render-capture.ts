import { renderCaptureControls } from "./ui-render-capture-controls.js";
import { buildCaptureViewModel } from "./ui-render-capture-model.js";
import { renderCaptureSummary } from "./ui-render-capture-summary.js";
import { renderCaptureWorkspace } from "./ui-render-capture-workspace.js";
import type { UiState } from "./ui-types.js";

export function renderCaptureView(state: UiState): string {
  const model = buildCaptureViewModel(state);
  const { events, filteredEvents, sessions } = model;
  return `
    <div class="events-view">
      <div class="events-header">
        <span class="events-header-title">Proxy Capture</span>
        <span class="text-dimmed text-sm">${sessions.length} sessions · ${filteredEvents.length}/${events.length} events shown</span>
      </div>
      <div class="text-dimmed text-sm" style="margin-bottom:14px">
        Raw traffic always appears in <strong>Recent Events</strong>. The preset only controls the optional analysis panel.
      </div>
${renderCaptureControls(model)}
${renderCaptureSummary(model)}
${renderCaptureWorkspace(model)}
    </div>`;
}
