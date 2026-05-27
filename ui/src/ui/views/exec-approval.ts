import { html, nothing } from "lit";
import { formatApprovalDisplayPath } from "../../../../src/infra/approval-display-paths.ts";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import "../components/modal-dialog.ts";
import type {
  ExecApprovalAction,
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../controllers/exec-approval.ts";

const DEFAULT_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

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

function decisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return t("execApproval.allowOnce");
  }
  if (decision === "allow-always") {
    return t("execApproval.alwaysAllow");
  }
  return t("execApproval.deny");
}

function decisionStyle(decision: ExecApprovalDecision): ExecApprovalAction["style"] {
  if (decision === "allow-once") {
    return "primary";
  }
  if (decision === "deny") {
    return "danger";
  }
  return "secondary";
}

function buttonClass(style: ExecApprovalAction["style"]) {
  if (style === "danger") {
    return "btn danger";
  }
  if (style === "primary" || style === "success") {
    return "btn primary";
  }
  return "btn";
}

function resolveExecApprovalDecisions(
  active: ExecApprovalRequest,
): readonly ExecApprovalDecision[] {
  if (active.request.allowedDecisions?.length) {
    return active.request.allowedDecisions;
  }
  if (active.request.ask === "always") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_APPROVAL_DECISIONS;
}

function resolveApprovalActions(active: ExecApprovalRequest): ExecApprovalAction[] {
  if (active.kind === "exec") {
    return resolveExecApprovalDecisions(active).map((decision) => ({
      kind: "decision",
      decision,
      label: decisionLabel(decision),
      style: decisionStyle(decision),
    }));
  }
  const actions = [...(active.actions ?? [])];
  const representedDecisions = new Set(
    actions.flatMap((action) => (action.kind === "decision" ? [action.decision] : [])),
  );
  const allowedDecisions =
    active.allowedDecisions ?? active.request.allowedDecisions ?? DEFAULT_APPROVAL_DECISIONS;
  for (const decision of allowedDecisions) {
    if (representedDecisions.has(decision)) {
      continue;
    }
    actions.push({
      kind: "decision",
      decision,
      label: decisionLabel(decision),
      style: decisionStyle(decision),
    });
  }
  return actions;
}

function resolveDecisionValues(actions: readonly ExecApprovalAction[]): ExecApprovalDecision[] {
  return actions.flatMap((action) => (action.kind === "decision" ? [action.decision] : []));
}

function renderUnavailableDecisionWarning(
  active: ExecApprovalRequest,
  actions: readonly ExecApprovalAction[],
) {
  const decisions = resolveDecisionValues(actions);
  return active.kind !== "exec" || decisions.includes("allow-always")
    ? nothing
    : html`<div class="exec-approval-warning">${t("execApproval.allowAlwaysUnavailable")}</div>`;
}

function renderApprovalAction(action: ExecApprovalAction, state: AppViewState) {
  if (action.kind === "command") {
    return html`<div class="exec-approval-command-action">
      <span>${action.label}</span>
      <code>${action.command}</code>
    </div>`;
  }
  return html`<button
    class=${buttonClass(action.style)}
    ?disabled=${state.execApprovalBusy}
    @click=${() => state.handleExecApprovalDecision(action.decision)}
  >
    ${action.label}
  </button>`;
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
  const actions = resolveApprovalActions(active);
  const decisions = resolveDecisionValues(actions);
  const handleCancel = () => {
    if (!state.execApprovalBusy && decisions.includes("deny")) {
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
        ${renderUnavailableDecisionWarning(active, actions)}
        ${state.execApprovalError
          ? html`<div class="exec-approval-error">${state.execApprovalError}</div>`
          : nothing}
        <div class="exec-approval-actions">
          ${actions.map((action) => renderApprovalAction(action, state))}
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
