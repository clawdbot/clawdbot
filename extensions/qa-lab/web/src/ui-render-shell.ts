import { findScenarioOutcome, statusDotClass } from "./ui-render-scenario.js";
import { badgeHtml, esc, formatIso } from "./ui-render-utils.js";
import type { RunnerModelOption, RunnerSelection, TabId, UiState } from "./ui-types.js";

const MOCK_MODELS: RunnerModelOption[] = [
  {
    key: "mock-openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna (mock)",
    provider: "mock-openai",
    input: "text",
    preferred: true,
  },
  {
    key: "mock-openai/gpt-5.6-luna-alt",
    name: "GPT-5.6 Luna Alt (mock)",
    provider: "mock-openai",
    input: "text",
    preferred: false,
  },
];

function deriveSelection(state: UiState): RunnerSelection | null {
  return state.runnerDraft ?? state.bootstrap?.runner.selection ?? null;
}

/* ===== Render: Header ===== */

export function renderHeader(state: UiState): string {
  const runner = state.bootstrap?.runner ?? null;
  const run = state.scenarioRun;
  const controlUrl = state.bootstrap?.controlUiUrl;

  return `
    <header class="header">
      <div class="header-left">
        <span class="header-title">QA Lab</span>
        <div class="header-status">
          ${runner ? badgeHtml(runner.status) : ""}
          ${run ? `<span class="badge badge-accent">${run.counts.passed}/${run.counts.total} pass</span>` : ""}
          ${state.error ? `<span class="badge badge-fail">${esc(state.error)}</span>` : ""}
        </div>
      </div>
      <div class="header-right">
        ${controlUrl ? `<a class="header-link" href="${esc(controlUrl)}" target="_blank" rel="noreferrer">Control UI</a>` : ""}
        <button class="btn-ghost btn-sm" data-action="toggle-sidebar">${state.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}</button>
        <button class="btn-ghost btn-sm" data-action="refresh"${state.busy ? " disabled" : ""}>Refresh</button>
        <button class="btn-ghost btn-sm" data-action="reset"${state.busy ? " disabled" : ""}>Reset</button>
        <button class="theme-toggle" data-action="toggle-theme" title="Toggle theme">${state.theme === "dark" ? "\u2600" : "\u263E"}</button>
      </div>
    </header>`;
}

/* ===== Render: Sidebar ===== */

function renderModelSelect(params: {
  id: string;
  label: string;
  value: string;
  options: RunnerModelOption[];
  disabled: boolean;
}): string {
  const values = new Set(params.options.map((o) => o.key));
  const options = [...params.options];
  if (!values.has(params.value) && params.value.trim()) {
    options.unshift({
      key: params.value,
      name: params.value,
      provider: params.value.split("/")[0] ?? "custom",
      input: "text",
      preferred: false,
    });
  }
  return `
    <div class="config-field">
      <span class="config-label">${esc(params.label)}</span>
      <select id="${esc(params.id)}"${params.disabled ? " disabled" : ""}>
        ${options
          .map(
            (o) =>
              `<option value="${esc(o.key)}"${o.key === params.value ? " selected" : ""}>${esc(o.key)}</option>`,
          )
          .join("")}
      </select>
    </div>`;
}

export function renderSidebar(state: UiState): string {
  const scenarios = state.bootstrap?.scenarios ?? [];
  const selection = deriveSelection(state);
  const runner = state.bootstrap?.runner ?? null;
  const run = state.scenarioRun;
  const isRunning = runner?.status === "running";
  const realModels = state.bootstrap?.runnerCatalog.real ?? [];
  const modelOptions =
    selection?.providerMode === "live-frontier" && realModels.length > 0 ? realModels : MOCK_MODELS;
  const selectedIds = new Set(selection?.scenarioIds ?? []);

  return `
    <aside class="sidebar${state.sidebarCollapsed ? " is-collapsed" : ""}">
      <div class="sidebar-panel-tabs">
        <button class="btn-sm btn-ghost sidebar-panel-tab${state.sidebarPanel === "scenarios" ? " active" : ""}" data-sidebar-panel="scenarios">Scenarios</button>
        <button class="btn-sm btn-ghost sidebar-panel-tab${state.sidebarPanel === "config" ? " active" : ""}" data-sidebar-panel="config">Config</button>
        <button class="btn-sm btn-ghost sidebar-panel-tab${state.sidebarPanel === "run" ? " active" : ""}" data-sidebar-panel="run">Run</button>
      </div>
      ${
        state.sidebarPanel === "config"
          ? `<div class="sidebar-section sidebar-panel-body">
              <div class="sidebar-section-title"><h3>Configuration</h3></div>
              <div class="config-field">
                <span class="config-label">Provider lane</span>
                <select id="provider-mode"${isRunning ? " disabled" : ""}>
                  <option value="mock-openai"${selection?.providerMode === "mock-openai" ? " selected" : ""}>Synthetic (mock)</option>
                  <option value="live-frontier"${selection?.providerMode === "live-frontier" ? " selected" : ""}>Real frontier providers</option>
                </select>
              </div>
              ${renderModelSelect({
                id: "primary-model",
                label: "Primary model",
                value: selection?.primaryModel ?? "",
                options: modelOptions,
                disabled: isRunning,
              })}
              ${renderModelSelect({
                id: "alternate-model",
                label: "Alternate model",
                value: selection?.alternateModel ?? "",
                options: modelOptions,
                disabled: isRunning,
              })}
              ${
                selection?.providerMode === "live-frontier"
                  ? `<div class="config-hint">${esc(
                      state.bootstrap?.runnerCatalog.status === "loading"
                        ? "Loading model catalog\u2026"
                        : state.bootstrap?.runnerCatalog.status === "failed"
                          ? "Catalog unavailable; using manual input."
                          : `${realModels.length} models available`,
                    )}</div>`
                  : ""
              }
            </div>`
          : state.sidebarPanel === "run"
            ? `<div class="sidebar-panel-body">${run || runner ? renderRunStatus(state) : '<div class="sidebar-section"><div class="text-dimmed text-sm">No run data yet.</div></div>'}</div>`
            : `<div class="sidebar-section sidebar-scenarios sidebar-panel-body">
                <div class="sidebar-section-title">
                  <h3>Scenarios (${selectedIds.size}/${scenarios.length})</h3>
                  <div class="btn-group">
                    <button class="btn-sm btn-ghost" data-action="select-all-scenarios"${isRunning ? " disabled" : ""}>All</button>
                    <button class="btn-sm btn-ghost" data-action="clear-scenarios"${isRunning ? " disabled" : ""}>None</button>
                  </div>
                </div>
                <div class="scenario-scroll">
                  ${scenarios
                    .map((s) => {
                      const outcome = findScenarioOutcome(state, s);
                      const status = outcome?.status ?? "pending";
                      return `
                        <label class="scenario-item">
                          <input type="checkbox" data-scenario-toggle-id="${esc(s.id)}"${selectedIds.has(s.id) ? " checked" : ""}${isRunning ? " disabled" : ""} />
                          <span class="${statusDotClass(status)}"></span>
                          <div class="scenario-item-info">
                            <span class="scenario-item-title">${esc(s.title)}</span>
                            <span class="scenario-item-meta">${esc(s.surface)} · ${esc(s.id)}</span>
                          </div>
                        </label>`;
                    })
                    .join("")}
                </div>
              </div>`
      }

      <!-- Actions -->
      <div class="sidebar-actions">
        <button class="btn-primary" data-action="run-suite"${isRunning || !selectedIds.size || state.busy ? " disabled" : ""}>
          Run ${selectedIds.size} scenario${selectedIds.size === 1 ? "" : "s"}
        </button>
        <div class="btn-row">
          <button data-action="self-check"${isRunning || state.busy ? " disabled" : ""}>Self-check</button>
          <button data-action="kickoff"${isRunning || state.busy ? " disabled" : ""}>Kickoff</button>
        </div>
      </div>
    </aside>`;
}

function renderRunStatus(state: UiState): string {
  const run = state.scenarioRun;
  const runner = state.bootstrap?.runner ?? null;
  if (!run && !runner) {
    return "";
  }

  return `
    <div class="sidebar-section run-status">
      <div class="sidebar-section-title">
        <h3>Run Status</h3>
        ${runner ? badgeHtml(runner.status) : ""}
      </div>
      ${
        run
          ? `<div class="run-counts">
              <div class="run-count"><span class="run-count-value">${run.counts.total}</span><span class="run-count-label">Total</span></div>
              <div class="run-count"><span class="run-count-value count-pass">${run.counts.passed}</span><span class="run-count-label">Pass</span></div>
              <div class="run-count"><span class="run-count-value count-fail">${run.counts.failed}</span><span class="run-count-label">Fail</span></div>
              <div class="run-count"><span class="run-count-value">${run.counts.pending + run.counts.running}</span><span class="run-count-label">Left</span></div>
            </div>`
          : ""
      }
      <div class="run-meta">
        ${runner?.startedAt ? `Started ${esc(formatIso(runner.startedAt))}` : ""}
        ${runner?.finishedAt ? `<br>Finished ${esc(formatIso(runner.finishedAt))}` : ""}
        ${runner?.error ? `<br><span style="color:var(--danger)">${esc(runner.error)}</span>` : ""}
      </div>
    </div>`;
}

/* ===== Render: Tab bar ===== */

export function renderTabBar(state: UiState): string {
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "chat", label: "Chat" },
    { id: "results", label: "Results" },
    { id: "evidence", label: "Evidence Archive" },
    { id: "report", label: "Report" },
    { id: "events", label: "Events" },
    { id: "capture", label: "Capture" },
  ];
  return `
    <nav class="tab-bar">
      ${tabs
        .map(
          (t) =>
            `<button class="tab-btn${state.activeTab === t.id ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`,
        )
        .join("")}
      <div class="tab-spacer"></div>
    </nav>`;
}

/* ===== Render: Chat tab ===== */
