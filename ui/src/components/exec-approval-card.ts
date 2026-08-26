import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { formatApprovalDisplayPath } from "../../../src/infra/approval-display-paths.ts";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../app/exec-approval.ts";
import { t } from "../i18n/index.ts";
import { formatCountdown } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { PollController } from "../lit/poll-controller.ts";
import { icons } from "./icons.ts";

const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

type ExecApprovalCardProps = {
  approval: ExecApprovalRequest;
  busy: boolean;
  canGrant: boolean;
  error: string | null;
  variant: "inline" | "modal";
  queueCount?: number;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
};

type SidebarApprovalRowProps = {
  approval: ExecApprovalRequest;
  busy: boolean;
  canGrant: boolean;
  error: string | null;
  openSessionHref?: string;
  sessionTitle?: string | null;
  onDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
  onOpenSession?: (event: MouseEvent) => void;
};

export function approvalRemainingLabel(expiresAtMs: number, nowMs: number): string {
  return expiresAtMs > nowMs
    ? t("execApproval.expiresIn", { time: formatCountdown(expiresAtMs, nowMs, true) })
    : t("execApproval.expired");
}

class ApprovalCountdown extends OpenClawLightDomContentsElement {
  @property({ type: Number }) expiresAtMs = 0;
  @property({ type: Boolean }) compact = false;

  private readonly polling = new PollController(
    this,
    1_000,
    () => {
      this.requestUpdate();
      if (!this.compact) {
        this.closest("openclaw-modal-dialog")?.setAttribute(
          "description",
          approvalRemainingLabel(this.expiresAtMs, Date.now()),
        );
      }
    },
    false,
  );

  override connectedCallback() {
    super.connectedCallback();
    this.polling.start();
  }

  override render() {
    const nowMs = Date.now();
    return html`${this.compact
      ? formatCountdown(this.expiresAtMs, nowMs, true)
      : approvalRemainingLabel(this.expiresAtMs, nowMs)}`;
  }
}

if (!customElements.get("openclaw-approval-countdown")) {
  customElements.define("openclaw-approval-countdown", ApprovalCountdown);
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

export function compactApprovalCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 64 ? `${truncateUtf16Safe(singleLine, 61)}…` : singleLine;
}

function approvalDecisionLabel(decision: ExecApprovalDecision, kind: ExecApprovalRequest["kind"]) {
  return t(
    decision === "allow-once"
      ? "execApproval.allowOnce"
      : decision === "allow-always"
        ? kind === "exec"
          ? "execApproval.alwaysAllowHere"
          : "execApproval.alwaysAllow"
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

export function renderSidebarApprovalRow(props: SidebarApprovalRowProps) {
  const approval = props.approval;
  const nowMs = Date.now();
  const expired = approval.expiresAtMs <= nowMs;
  const command = compactApprovalCommand(approval.request.command);
  const sessionKey = approval.request.sessionKey?.trim();
  const sessionTitle =
    props.sessionTitle ??
    (sessionKey ? resolveSessionDisplayName(sessionKey) : approvalTitle(approval));
  const expiryUrgent = expired || approval.expiresAtMs - nowMs < 2 * 60_000;
  const expiryLabel = approvalRemainingLabel(approval.expiresAtMs, nowMs);
  const reviewOnlyMessage = t("execApproval.reviewOnly");
  const grantError = !props.canGrant && props.error === reviewOnlyMessage;
  return html`<article
    class="sidebar-approval-row sidebar-issues-panel__details--warning"
    data-attention-kind="pendingApproval"
    data-approval-id=${approval.id}
  >
    <span class="sidebar-issues-panel__icon sidebar-approval-row__icon" aria-hidden="true"
      >${icons.shieldQuestion}</span
    >
    <div class="sidebar-approval-row__content">
      <div class="sidebar-approval-row__header" data-issue-row-focus tabindex="-1">
        <span class="sidebar-issues-panel__entity" title=${sessionTitle}>${sessionTitle}</span>
        <openclaw-approval-countdown
          class="sidebar-approval-row__timer ${expiryUrgent
            ? "sidebar-approval-row__timer--urgent"
            : ""}"
          role="timer"
          aria-label=${expiryLabel}
          title=${expiryLabel}
          .expiresAtMs=${approval.expiresAtMs}
          .compact=${true}
        ></openclaw-approval-countdown>
      </div>
      <div class="sidebar-approval-row__command mono" title=${approval.request.command}>
        <span aria-hidden="true">$ </span>${command}
      </div>
      <div
        class="sidebar-approval-row__actions"
        role="group"
        aria-label=${t("approvalPage.actionsLabel")}
      >
        ${resolveApprovalDecisions(approval).map((decision) => {
          const label = approvalDecisionLabel(decision, approval.kind);
          return html`<button
            type="button"
            class="btn btn--xs ${decision === "deny"
              ? "btn--ghost"
              : ""} sidebar-approval-row__action sidebar-approval-row__action--${decision}"
            aria-label=${t("execApproval.decisionRequest", { decision: label, command })}
            ?disabled=${props.busy || !props.canGrant || expired}
            @click=${(event: Event) => props.onDecision(event, approval.id, decision)}
          >
            ${label}
          </button>`;
        })}
        ${props.openSessionHref && props.onOpenSession
          ? html`<a
              class="sidebar-approval-row__open-session"
              href=${props.openSessionHref}
              aria-label=${t("sessionsView.openSession")}
              title=${t("sessionsView.openSession")}
              @click=${props.onOpenSession}
            >
              ${icons.arrowUpRight}
            </a>`
          : nothing}
      </div>
      ${!props.canGrant
        ? html`<div class="sidebar-approval-row__message" role=${grantError ? "alert" : "note"}>
            ${reviewOnlyMessage}
          </div>`
        : nothing}
      ${props.error && !grantError
        ? html`<div
            class="sidebar-approval-row__message sidebar-approval-row__message--error"
            role="alert"
          >
            ${props.error}
          </div>`
        : nothing}
    </div>
  </article>`;
}

export function renderExecApprovalCard(props: ExecApprovalCardProps) {
  const active = props.approval;
  const decisions = resolveApprovalDecisions(active);
  const reviewOnlyMessage = t("execApproval.reviewOnly");
  const grantError = !props.canGrant && props.error === reviewOnlyMessage;
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
        <openclaw-approval-countdown
          class="exec-approval-sub exec-approval-countdown"
          role="timer"
          .expiresAtMs=${active.expiresAtMs}
        ></openclaw-approval-countdown>
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
    ${!props.canGrant
      ? html`<div
          class=${grantError ? "exec-approval-error" : "exec-approval-warning"}
          role=${grantError ? "alert" : "note"}
        >
          ${reviewOnlyMessage}
        </div>`
      : nothing}
    ${props.error && !grantError
      ? html`<div class="exec-approval-error" role="alert">${props.error}</div>`
      : nothing}
    <div class="exec-approval-actions">
      ${decisions.map((decision) => {
        const label = approvalDecisionLabel(decision, props.approval.kind);
        return html`<button
          class=${decisionClass(decision)}
          type="button"
          aria-label=${label}
          ?disabled=${props.busy || !props.canGrant}
          title=${props.variant === "modal" && props.canGrant
            ? `${label} (${decisionShortcut(decision)})`
            : label}
          @click=${() => props.onDecision(active.id, decision)}
        >
          <span>${label}</span>
        </button>`;
      })}
    </div>
  </div>`;
}
