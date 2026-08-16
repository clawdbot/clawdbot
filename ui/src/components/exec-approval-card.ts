import { html, nothing } from "lit";
import { formatApprovalDisplayPath } from "../../../src/infra/approval-display-paths.ts";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../app/exec-approval.ts";
import { t } from "../i18n/index.ts";
import { formatCountdown } from "../lib/format.ts";

const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

type ExecApprovalCardProps = {
  approval: ExecApprovalRequest;
  busy: boolean;
  error: string | null;
  nowMs: number;
  variant: "inline" | "modal";
  queueCount?: number;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
};

export function approvalRemainingLabel(expiresAtMs: number, nowMs: number): string {
  return expiresAtMs > nowMs
    ? t("execApproval.expiresIn", { time: formatCountdown(expiresAtMs, nowMs, true) })
    : t("execApproval.expired");
}

function renderMetaRow(label: string, value?: string | null, opts?: { path?: boolean }) {
  if (!value) {
    return nothing;
  }
  return html`<div class="exec-approval-meta-row">
    <span>${label}</span><span>${opts?.path ? formatApprovalDisplayPath(value) : value}</span>
  </div>`;
}

function renderCommandWithSpans(request: ExecApprovalRequestPayload) {
  const spans = [...(request.commandSpans ?? [])]
    .filter(
      (span) =>
        Number.isSafeInteger(span.startIndex) &&
        Number.isSafeInteger(span.endIndex) &&
        span.startIndex >= 0 &&
        span.endIndex > span.startIndex &&
        span.endIndex <= request.command.length,
    )
    .toSorted((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const accepted: typeof spans = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.startIndex >= cursor) {
      accepted.push(span);
      cursor = span.endIndex;
    }
  }
  if (!accepted.length) {
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

function renderDetails(content: ReturnType<typeof html>) {
  return html`<details class="exec-approval-details">
    <summary>${t("execApproval.details")}</summary>
    <div class="exec-approval-meta">${content}</div>
  </details>`;
}

function renderChip(kind: "plugin" | "agent", id?: string | null) {
  return id
    ? html`<span class="exec-approval-chip mono" data-approval-chip=${kind}>${id}</span>`
    : nothing;
}

function renderExecBody(
  request: ExecApprovalRequestPayload,
  variant: ExecApprovalCardProps["variant"],
) {
  return html` ${renderCommandWithSpans(request)}
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.host"), request.host)}
      ${renderMetaRow(t("execApproval.labels.cwd"), request.cwd, { path: true })}
    </div>
    ${renderDetails(html`
      ${renderMetaRow(t("execApproval.labels.resolved"), request.resolvedPath, { path: true })}
      ${renderMetaRow(t("execApproval.labels.security"), request.security)}
      ${renderMetaRow(t("execApproval.labels.ask"), request.ask)}
      ${variant === "modal"
        ? renderMetaRow(t("execApproval.labels.session"), request.sessionKey)
        : nothing}
    `)}`;
}

function renderPluginBody(active: ExecApprovalRequest, variant: ExecApprovalCardProps["variant"]) {
  return html` ${active.pluginDescription
    ? html`<pre class="exec-approval-command mono">${active.pluginDescription}</pre>`
    : nothing}
  ${variant === "modal" && active.request.sessionKey
    ? renderDetails(
        html`${renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey)}`,
      )
    : nothing}`;
}

function decisionLabel(decision: ExecApprovalDecision) {
  return t(
    decision === "allow-once"
      ? "execApproval.allowOnce"
      : decision === "allow-always"
        ? "execApproval.alwaysAllow"
        : "execApproval.deny",
  );
}

function decisionClass(decision: ExecApprovalDecision) {
  return decision === "allow-once" ? "btn primary" : decision === "deny" ? "btn danger" : "btn";
}

function decisionShortcut(decision: ExecApprovalDecision) {
  return decision === "allow-once"
    ? "Ctrl/Cmd+Enter"
    : decision === "allow-always"
      ? "Ctrl/Cmd+Shift+Enter"
      : "Ctrl/Cmd+D";
}

export function resolveApprovalDecisions(
  active: ExecApprovalRequest,
): readonly ExecApprovalDecision[] {
  if (active.request.allowedDecisions?.length) {
    return active.request.allowedDecisions;
  }
  return active.kind === "exec" && active.request.ask === "always"
    ? ["allow-once", "deny"]
    : DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function approvalTitle(active: ExecApprovalRequest): string {
  return active.kind !== "exec"
    ? (active.pluginTitle ?? t("execApproval.pluginApprovalNeeded"))
    : t("execApproval.execApprovalNeeded");
}

export function renderExecApprovalCard(props: ExecApprovalCardProps) {
  const active = props.approval;
  const decisions = resolveApprovalDecisions(active);
  const rawSeverity = active.pluginSeverity?.trim().toLowerCase();
  const severity =
    active.kind === "exec" || rawSeverity === "warning" || rawSeverity === "warn"
      ? "warning"
      : rawSeverity === "danger" || rawSeverity === "critical" || rawSeverity === "error"
        ? "danger"
        : "info";
  const pluginId = active.kind === "plugin" ? active.pluginId?.trim() : null;
  const agentId = props.variant === "modal" ? active.request.agentId?.trim() : null;
  return html` <div
    class="exec-approval-card exec-approval-card--${props.variant} exec-approval-card--severity-${severity}"
    data-approval-id=${active.id}
  >
    <div class="exec-approval-header">
      <div>
        <div class="exec-approval-title">${approvalTitle(active)}</div>
        ${pluginId || agentId
          ? html`<div class="exec-approval-chips">
              ${renderChip("plugin", pluginId)} ${renderChip("agent", agentId)}
            </div>`
          : nothing}
        <div class="exec-approval-sub exec-approval-countdown" role="timer">
          ${approvalRemainingLabel(active.expiresAtMs, props.nowMs)}
        </div>
      </div>
      ${(props.queueCount ?? 0) > 1
        ? html`<div class="exec-approval-queue">
            ${t("execApproval.pending", { count: String(props.queueCount) })}
          </div>`
        : nothing}
    </div>
    ${active.kind === "exec"
      ? renderExecBody(active.request, props.variant)
      : renderPluginBody(active, props.variant)}
    ${active.kind === "exec" && !decisions.includes("allow-always")
      ? html`<div class="exec-approval-warning">${t("execApproval.allowAlwaysUnavailable")}</div>`
      : nothing}
    ${props.error ? html`<div class="exec-approval-error">${props.error}</div>` : nothing}
    <div class="exec-approval-actions">
      ${decisions.map((decision) => {
        const label = decisionLabel(decision);
        return html`<button
          class=${decisionClass(decision)}
          type="button"
          ?disabled=${props.busy}
          title=${props.variant === "modal" ? `${label} (${decisionShortcut(decision)})` : label}
          @click=${() => props.onDecision(active.id, decision)}
        >
          <span>${label}</span>
        </button>`;
      })}
    </div>
  </div>`;
}
