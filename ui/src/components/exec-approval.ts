// Control UI modal queues approvals that are not currently inline in chat.
import { html, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { modalApprovalQueue } from "../app/approval-presentation.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../app/exec-approval.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import {
  approvalRemainingLabel,
  approvalTitle,
  formatApprovalCountdown,
  renderExecApprovalCard,
  resolveApprovalDecisions,
} from "./exec-approval-card.ts";
import type { OpenClawModalDialog } from "./modal-dialog.ts";
import "./modal-dialog.ts";

type ExecApprovalProps = {
  queue: readonly ExecApprovalRequest[];
  busy: boolean;
  errors: ReadonlyMap<string, string>;
  nowMs: number;
  inlineApprovalId?: string | null;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
};

function compactCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 64 ? `${singleLine.slice(0, 61)}…` : singleLine;
}

function renderApprovalQueueList(params: {
  queue: readonly ExecApprovalRequest[];
  activeId: string;
  nowMs: number;
  onSelect: (approvalId: string) => void;
}) {
  const others = params.queue.filter((entry) => entry.id !== params.activeId);
  if (others.length === 0) {
    return nothing;
  }
  return html`
    <div class="exec-approval-list" aria-label=${t("execApproval.otherPending")}>
      <div class="exec-approval-list__heading">${t("execApproval.otherPending")}</div>
      ${others.map((entry) => {
        const command = compactCommand(entry.request.command);
        const agent = entry.request.agentId?.trim() || "—";
        const countdown = formatApprovalCountdown(entry.expiresAtMs, params.nowMs);
        return html`
          <button
            class="exec-approval-list__item"
            type="button"
            aria-label=${t("execApproval.reviewRequest", { agent, command })}
            @click=${() => params.onSelect(entry.id)}
          >
            <span class="exec-approval-list__agent">${agent}</span>
            <span class="exec-approval-list__command mono">${command}</span>
            <span class="exec-approval-list__expiry" aria-hidden="true">${countdown}</span>
          </button>
        `;
      })}
    </div>
  `;
}

function keyEventComesFromTextEntry(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") !==
          null,
    );
}

// Authorization shortcuts require a Ctrl/Cmd chord: the modal steals focus
// when it opens, so a bare letter typed mid-sentence into the composer could
// otherwise approve a command the user never read.
function shortcutDecision(event: KeyboardEvent): ExecApprovalDecision | null {
  const hasModChord = (event.metaKey || event.ctrlKey) && !event.altKey;
  if (!hasModChord || keyEventComesFromTextEntry(event)) {
    return null;
  }
  if (event.key === "Enter") {
    return event.shiftKey ? "allow-always" : "allow-once";
  }
  return !event.shiftKey && event.key.toLowerCase() === "d" ? "deny" : null;
}

class ExecApproval extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: ExecApprovalProps;
  @query("openclaw-modal-dialog") private dialog?: OpenClawModalDialog;
  @state() private selectedApprovalId: string | null = null;
  @state() private forceShowAll = false;

  show(): void {
    this.forceShowAll = true;
    void this.updateComplete.then(() => this.dialog?.show());
  }

  private displayedQueue(): readonly ExecApprovalRequest[] {
    const props = this.props;
    if (!props) {
      return [];
    }
    return this.forceShowAll
      ? props.queue
      : modalApprovalQueue(props.queue, props.inlineApprovalId);
  }

  private activeApproval(queue: readonly ExecApprovalRequest[]): ExecApprovalRequest | null {
    return queue.find((entry) => entry.id === this.selectedApprovalId) ?? queue.at(0) ?? null;
  }

  private handleKeydown(event: KeyboardEvent, active: ExecApprovalRequest): void {
    // A held chord auto-repeats: once a decision settles and the queue
    // advances, the repeat would apply the same decision to the next request.
    if (event.defaultPrevented || event.repeat || this.props?.busy) {
      return;
    }
    const decision = shortcutDecision(event);
    if (!decision || !resolveApprovalDecisions(active).includes(decision)) {
      return;
    }
    event.preventDefault();
    void this.props?.onDecision(active.id, decision);
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    const previousProps = changedProperties.get("props") as ExecApprovalProps | undefined;
    if (previousProps?.queue.length && !this.props?.queue.length) {
      this.forceShowAll = false;
      this.selectedApprovalId = null;
      return;
    }
    // Pin the presented request: late-arriving older approvals re-sort the
    // queue, and swapping the card mid-read (or mid-decision) could attach the
    // user's answer or a failure message to a request they never saw.
    const displayedQueue = this.displayedQueue();
    if (!displayedQueue.some((entry) => entry.id === this.selectedApprovalId)) {
      this.selectedApprovalId = displayedQueue.at(0)?.id ?? null;
    }
  }

  override render() {
    const props = this.props;
    const queue = this.displayedQueue();
    const active = this.activeApproval(queue);
    if (!props || !active) {
      return nothing;
    }
    const decisions = resolveApprovalDecisions(active);
    const handleCancel = () => {
      if (!props.busy && decisions.includes("deny")) {
        void props.onDecision(active.id, "deny");
      }
    };
    return html`
      <openclaw-modal-dialog
        label=${approvalTitle(active)}
        description=${approvalRemainingLabel(active.expiresAtMs, props.nowMs)}
        @keydown=${(event: KeyboardEvent) => this.handleKeydown(event, active)}
        @modal-cancel=${handleCancel}
      >
        <div class="exec-approval-modal-stack">
          ${renderExecApprovalCard({
            approval: active,
            busy: props.busy,
            error: props.errors.get(active.id) ?? null,
            nowMs: props.nowMs,
            variant: "modal",
            queueCount: queue.length,
            onDecision: props.onDecision,
          })}
          ${renderApprovalQueueList({
            queue,
            activeId: active.id,
            nowMs: props.nowMs,
            onSelect: (approvalId) => {
              this.selectedApprovalId = approvalId;
            },
          })}
        </div>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("openclaw-exec-approval")) {
  customElements.define("openclaw-exec-approval", ExecApproval);
}
