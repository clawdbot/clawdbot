import { renderCaptureView } from "./ui-render-capture.js";
import { renderEvidenceView } from "./ui-render-evidence.js";
import {
  renderChatView,
  renderEventsView,
  renderHeader,
  renderReportView,
  renderResultsView,
  renderSidebar,
  renderTabBar,
} from "./ui-render-main.js";
import type { UiState } from "./ui-types.js";

export * from "./ui-types.js";

function renderActiveTab(state: UiState): string {
  switch (state.activeTab) {
    case "chat":
      return renderChatView(state);
    case "results":
      return renderResultsView(state);
    case "evidence":
      return renderEvidenceView(state);
    case "report":
      return renderReportView(state);
    case "events":
      return renderEventsView(state);
    case "capture":
      return renderCaptureView(state);
    default:
      return renderChatView(state);
  }
}

export function renderQaLabUi(state: UiState): string {
  const shellClasses = [
    "app-shell",
    state.sidebarCollapsed ? "app-shell--sidebar-collapsed" : "",
    state.activeTab === "evidence" ? "app-shell--evidence-focus" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `
    <div class="${shellClasses}" data-theme="${state.theme}">
      ${renderHeader(state)}
      <div class="layout">
        ${renderSidebar(state)}
        <main class="main-content">
          ${renderTabBar(state)}
          <div class="tab-content">
            ${renderActiveTab(state)}
          </div>
        </main>
      </div>
    </div>`;
}
