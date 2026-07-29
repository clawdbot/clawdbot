// Shared approval card keeps the inline surface independent from the lazy modal.
import { html, nothing } from "lit";
import { formatApprovalDisplayPath } from "../../../src/infra/approval-display-paths.ts";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../app/exec-approval.ts";
import { t } from "../i18n/index.ts";

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

export function formatApprovalCountdown(expiresAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

export function approvalRemainingLabel(expiresAtMs: number, nowMs: number): string {
  return expiresAtMs > nowMs
    ? t("execApproval.expiresIn", { time: formatApprovalCountdown(expiresAtMs, nowMs) })
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

function renderExecBody(request: ExecApprovalRequestPayload) {
  return html` ${renderCommandWithSpans(request)}
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.host"), request.host)}
      ${renderMetaRow(t("execApproval.labels.agent"), request.agentId)}
      ${renderMetaRow(t("execApproval.labels.session"), request.sessionKey)}
      ${renderMetaRow(t("execApproval.labels.cwd"), request.cwd, { path: true })}
      ${renderMetaRow(t("execApproval.labels.resolved"), request.resolvedPath, { path: true })}
      ${renderMetaRow(t("execApproval.labels.security"), request.security)}
      ${renderMetaRow(t("execApproval.labels.ask"), request.ask)}
    </div>`;
}

function renderPluginBody(active: ExecApprovalRequest) {
  return html` ${active.pluginDescription
      ? html`<pre class="exec-approval-command mono" style="white-space:pre-wrap">
${active.pluginDescription}</pre>`
      : nothing}
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.severity"), active.pluginSeverity)}
      ${renderMetaRow(t("execApproval.labels.plugin"), active.pluginId)}
      ${renderMetaRow(t("execApproval.labels.agent"), active.request.agentId)}
      ${renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey)}
    </div>`;
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
  const title = approvalTitle(active);
  // A timer role preserves context without per-second aria-live announcements.
  return html` <div
    class="exec-approval-card exec-approval-card--${props.variant}"
    data-approval-id=${active.id}
  >
    <div class="exec-approval-header">
      <div>
        <div class="exec-approval-title">${title}</div>
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
    ${active.kind === "exec" ? renderExecBody(active.request) : renderPluginBody(active)}
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
