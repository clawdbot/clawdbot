import { html, nothing } from "lit";
import { formatApprovalDisplayPath } from "../../../../src/infra/approval-display-paths.ts";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import "../components/modal-dialog.ts";
import type {
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../controllers/exec-approval.ts";

function formatRemaining(ms: number): string {
  const remaining = Math.max(0, ms);
  const totalSeconds = Math.floor(remaining / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function renderMetaRow(label: string, value?: string | null, opts?: { path?: boolean }) {
  if (!value) {
    return nothing;
  }
  const displayValue = opts?.path ? formatApprovalDisplayPath(value) : value;
  return html`<div class="exec-approval-meta-row">
    <span>${label}</span><span>${displayValue}</span>
  </div>`;
}

function renderCommandWithSpans(request: ExecApprovalRequestPayload) {
  const commandSpans = [...(request.commandSpans ?? [])]
    .filter(
      (span) =>
        Number.isSafeInteger(span.startIndex) &&
        Number.isSafeInteger(span.endIndex) &&
        span.startIndex >= 0 &&
        span.endIndex > span.startIndex &&
        span.endIndex <= request.command.length,
    )
    .toSorted((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const accepted: typeof commandSpans = [];
  let cursor = 0;
  for (const span of commandSpans) {
    if (span.startIndex < cursor) {
      continue;
    }
    accepted.push(span);
    cursor = span.endIndex;
  }
  if (accepted.length === 0) {
    return html`<div class="exec-approval-command mono">${request.command}</div>`;
  }
  const parts = [];
  cursor = 0;
  for (const span of accepted) {
    if (span.startIndex > cursor) {
      parts.push(request.command.slice(cursor, span.startIndex));
    }
    parts.push(
      html`<mark class="exec-approval-command-span"
        >${request.command.slice(span.startIndex, span.endIndex)}</mark
      >`,
    );
    cursor = span.endIndex;
  }
  if (cursor < request.command.length) {
    parts.push(request.command.slice(cursor));
  }
  return html`<div class="exec-approval-command mono">${parts}</div>`;
}

function renderExecBody(request: ExecApprovalRequestPayload) {
  return html`
    ${renderCommandWithSpans(request)}
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.host"), request.host)}
      ${renderMetaRow(t("execApproval.labels.agent"), request.agentId)}
      ${renderMetaRow(t("execApproval.labels.session"), request.sessionKey)}
      ${renderMetaRow(t("execApproval.labels.cwd"), request.cwd, {
        path: true,
      })}
      ${renderMetaRow(t("execApproval.labels.resolved"), request.resolvedPath, { path: true })}
      ${renderMetaRow(t("execApproval.labels.security"), request.security)}
      ${renderMetaRow(t("execApproval.labels.ask"), request.ask)}
    </div>
  `;
}

function renderPluginBody(active: ExecApprovalRequest) {
  return html`
    ${active.pluginDescription
      ? html`<pre class="exec-approval-command mono" style="white-space:pre-wrap">
${active.pluginDescription}</pre
        >`
      : nothing}
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.severity"), active.pluginSeverity)}
      ${renderMetaRow(t("execApproval.labels.plugin"), active.pluginId)}
      ${renderMetaRow(t("execApproval.labels.agent"), active.request.agentId)}
      ${renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey)}
    </div>
  `;
}

export function renderExecApprovalPrompt(state: AppViewState) {
  const active = state.execApprovalQueue[0];
  if (!active) {
    return nothing;
  }
  const request = active.request;
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining =
    remainingMs > 0
      ? t("execApproval.expiresIn", { time: formatRemaining(remainingMs) })
      : t("execApproval.expired");
  const queueCount = state.execApprovalQueue.length;
  const isPlugin = active.kind === "plugin";
  const title = isPlugin
    ? (active.pluginTitle ?? t("execApproval.pluginApprovalNeeded"))
    : t("execApproval.execApprovalNeeded");
  const titleId = "exec-approval-title";
  const descriptionId = "exec-approval-description";
  const handleCancel = () => {
    if (!state.execApprovalBusy) {
      void state.handleExecApprovalDecision("deny");
    }
  };
  return html`
    <openclaw-modal-dialog label=${title} description=${remaining} @modal-cancel=${handleCancel}>
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div id=${titleId} class="exec-approval-title">${title}</div>
            <div id=${descriptionId} class="exec-approval-sub">${remaining}</div>
          </div>
          ${queueCount > 1
            ? html`<div class="exec-approval-queue">
                ${t("execApproval.pending", { count: String(queueCount) })}
              </div>`
            : nothing}
        </div>
        ${isPlugin ? renderPluginBody(active) : renderExecBody(request)}
        ${state.execApprovalError
          ? html`<div class="exec-approval-error">${state.execApprovalError}</div>`
          : nothing}
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-once")}
          >
            ${t("execApproval.allowOnce")}
          </button>
          <button
            class="btn"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-always")}
          >
            ${t("execApproval.alwaysAllow")}
          </button>
          <button
            class="btn danger"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("deny")}
          >
            ${t("execApproval.deny")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
