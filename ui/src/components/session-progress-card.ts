import type { ProgressCard, ProgressCardStep, SessionRunStatus } from "@openclaw/gateway-protocol";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { icons } from "./icons.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

type SessionProgressCardPlacement = "board" | "composer";
type PresentedProgressStepStatus = ProgressCardStep["status"] | "paused";

const STATUS_LABEL_KEYS: Record<ProgressCardStep["status"], Parameters<typeof t>[0]> = {
  completed: "sessionProgressCard.status.completed",
  in_progress: "sessionProgressCard.status.inProgress",
  pending: "sessionProgressCard.status.pending",
};

const ACTIVITY_LABEL_KEYS: Record<SessionRunStatus, Parameters<typeof t>[0]> = {
  queued: "sessionProgressCard.activity.updated",
  running: "sessionProgressCard.activity.updated",
  done: "sessionProgressCard.activity.completed",
  failed: "sessionProgressCard.activity.failed",
  killed: "sessionProgressCard.activity.stopped",
  timeout: "sessionProgressCard.activity.failed",
};

const TERMINAL_OUTCOME_LABEL_KEYS: Partial<Record<SessionRunStatus, Parameters<typeof t>[0]>> = {
  done: "sessionProgressCard.outcome.completed",
  failed: "sessionProgressCard.outcome.failed",
  killed: "sessionProgressCard.outcome.stopped",
  timeout: "sessionProgressCard.outcome.failed",
};

const TERMINAL_STEP_STATUS_LABEL_KEYS: Partial<Record<SessionRunStatus, Parameters<typeof t>[0]>> =
  {
    done: "sessionProgressCard.status.completed",
    failed: "sessionProgressCard.status.failed",
    killed: "sessionProgressCard.status.stopped",
    timeout: "sessionProgressCard.status.failed",
  };

class ProgressActivityTimeDirective extends AsyncDirective {
  private timestamp = 0;
  private labelKey: Parameters<typeof t>[0] = "sessionProgressCard.activity.updated";
  private timer: ReturnType<typeof setInterval> | undefined;

  render(timestamp: number, labelKey: Parameters<typeof t>[0]) {
    this.timestamp = timestamp;
    this.labelKey = labelKey;
    if (this.isConnected) {
      this.startTimer();
    }
    return this.renderTime();
  }

  protected override disconnected(): void {
    this.stopTimer();
  }

  protected override reconnected(): void {
    this.setValue(this.renderTime());
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.setValue(this.renderTime()), 30_000);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private renderTime() {
    const label = t(this.labelKey, { time: formatRelativeTimestamp(this.timestamp) });
    return html`<time
      datetime=${new Date(this.timestamp).toISOString()}
      aria-label=${label}
      title=${label}
      >${label}</time
    >`;
  }
}

const progressActivityTime = directive(ProgressActivityTimeDirective);

type ComposerProgressRunLifecycle = {
  activeRunId?: string | null;
  completedRunId?: string | null;
};

type ComposerDisclosureOwner = {
  activeRunId: string | null;
  handledCompletedRunId: string | null;
  sessionKey: string;
};

const composerDisclosureOwners = new WeakMap<HTMLDetailsElement, ComposerDisclosureOwner>();

function reconcileComposerDisclosure(
  element: Element | undefined,
  sessionKey: string,
  initialOpen: boolean,
  collapseByDefault: boolean,
  lifecycle?: ComposerProgressRunLifecycle,
): void {
  if (!(element instanceof HTMLDetailsElement)) {
    return;
  }
  const activeRunId = lifecycle?.activeRunId ?? null;
  const completedRunId = lifecycle?.completedRunId ?? null;
  const owner = composerDisclosureOwners.get(element);
  if (!owner || owner.sessionKey !== sessionKey) {
    element.open = initialOpen;
    composerDisclosureOwners.set(element, {
      activeRunId,
      handledCompletedRunId: completedRunId,
      sessionKey,
    });
    return;
  }
  // Run boundaries intentionally override the native disclosure. Same-run
  // rerenders leave the operator's manual open/closed choice untouched.
  if (activeRunId && activeRunId !== owner.activeRunId) {
    owner.activeRunId = activeRunId;
    owner.handledCompletedRunId = null;
    if (collapseByDefault) {
      element.open = false;
    }
  }
  if (
    completedRunId &&
    completedRunId === owner.activeRunId &&
    completedRunId !== owner.handledCompletedRunId
  ) {
    owner.handledCompletedRunId = completedRunId;
    if (collapseByDefault) {
      element.open = true;
    }
  }
}

function progressCounts(card: ProgressCard): { completed: number; total: number } | null {
  const steps = card.steps;
  if (!steps?.length) {
    return null;
  }
  return {
    completed: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
  };
}

type ProgressCardHeadsUp = {
  completed: number;
  status: PresentedProgressStepStatus;
  step: string;
  total: number;
};

function unfinishedProgressStep(steps: readonly ProgressCardStep[]): ProgressCardStep | undefined {
  return (
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending")
  );
}

function isProgressCardStaleForRun(card: ProgressCard, startedAt?: number): boolean {
  const runStart = asDateTimestampMs(startedAt);
  const cardUpdate = asDateTimestampMs(card.updatedAt);
  return runStart !== undefined && cardUpdate !== undefined && cardUpdate < runStart;
}

export function progressCardHeadsUp(
  card: ProgressCard | null | undefined,
  sessionStatus?: SessionRunStatus,
  startedAt?: number,
): ProgressCardHeadsUp | null {
  const staleForRun = card ? isProgressCardStaleForRun(card, startedAt) : false;
  if (sessionStatus && TERMINAL_OUTCOME_LABEL_KEYS[sessionStatus] && !staleForRun) {
    return null;
  }
  const counts = card ? progressCounts(card) : null;
  if (!counts || !card?.steps) {
    return null;
  }
  const step = unfinishedProgressStep(card.steps);
  if (!step) {
    return null;
  }
  const status = step.status === "in_progress" && staleForRun ? "paused" : step.status;
  return { ...counts, status, step: step.step };
}

function currentProgressStep(steps: readonly ProgressCardStep[]): ProgressCardStep | undefined {
  return unfinishedProgressStep(steps) ?? steps.findLast((step) => step.status === "completed");
}

function progressStepMarker(status: PresentedProgressStepStatus, sessionStatus?: SessionRunStatus) {
  if (status === "in_progress" && sessionStatus === "done") {
    return icons.check;
  }
  if (
    status === "in_progress" &&
    (sessionStatus === "failed" || sessionStatus === "timeout" || sessionStatus === "killed")
  ) {
    return icons.circleX;
  }
  switch (status) {
    case "completed":
      return icons.check;
    case "in_progress":
      return html`<span class="session-run-spinner"></span>`;
    case "paused":
    case "pending":
      return icons.clock;
  }
  return status satisfies never;
}

function currentProgressPosition(steps: readonly ProgressCardStep[]): number {
  const current = currentProgressStep(steps);
  const index = current ? steps.indexOf(current) : -1;
  return Math.max(1, index + 1);
}

function promoteFirstProgressBar(sanitizedHtml: string): string {
  const template = document.createElement("template");
  template.innerHTML = sanitizedHtml;
  const progress = template.content.querySelector("progress");
  if (!progress) {
    return sanitizedHtml;
  }
  const value = progress.getAttribute("value")?.trim();
  const max = progress.getAttribute("max")?.trim();
  const label =
    progress.getAttribute("aria-label")?.trim() ||
    (value && max
      ? `${t("sessionProgressCard.title")} · ${value}/${max}`
      : t("sessionProgressCard.title"));
  progress.setAttribute("aria-label", label);
  const originalParent = progress.parentElement;
  const wrapper = document.createElement("div");
  wrapper.className = "session-progress-card__progress";
  const visibleLabel = document.createElement("span");
  visibleLabel.className = "session-progress-card__progress-label";
  visibleLabel.textContent = label;
  wrapper.append(visibleLabel, progress);
  if (
    originalParent?.tagName === "P" &&
    originalParent.children.length === 0 &&
    !originalParent.textContent?.trim()
  ) {
    originalParent.remove();
  }
  // Reorder only the already-sanitized tree; generated copy uses textContent so
  // promoting a bar cannot reintroduce authored markup or event handlers.
  template.content.prepend(wrapper);
  return template.innerHTML;
}

export function renderProgressCardMarkdown(
  markdown: string | undefined,
  options: { promoteProgress?: boolean } = {},
) {
  if (!markdown) {
    return nothing;
  }
  const sanitizedHtml = toSanitizedMarkdownHtml(markdown, { progressBars: true });
  return html`<div class="session-progress-card__markdown sidebar-markdown">
    ${unsafeHTML(options.promoteProgress ? promoteFirstProgressBar(sanitizedHtml) : sanitizedHtml)}
  </div>`;
}

function renderSteps(card: ProgressCard, hasActiveRun: boolean, sessionStatus?: SessionRunStatus) {
  const steps = card.steps;
  if (!steps?.length) {
    return nothing;
  }
  return html`<ol class="session-progress-card__steps">
    ${steps.map((step) => {
      const terminalStatusKey =
        step.status === "in_progress" && sessionStatus
          ? TERMINAL_STEP_STATUS_LABEL_KEYS[sessionStatus]
          : undefined;
      const presentedStatus =
        step.status === "in_progress" && !hasActiveRun && !terminalStatusKey
          ? "paused"
          : step.status;
      const statusLabel = t(
        terminalStatusKey ??
          (presentedStatus === "paused"
            ? "sessionProgressCard.status.paused"
            : STATUS_LABEL_KEYS[presentedStatus]),
      );
      return html`<li
        class="session-progress-card__step session-progress-card__step--${presentedStatus}"
        aria-label=${t("sessionProgressCard.stepLabel", { status: statusLabel, step: step.step })}
      >
        <span
          class="session-progress-card__step-marker"
          data-status=${presentedStatus}
          data-outcome=${terminalStatusKey ? sessionStatus : nothing}
          aria-hidden="true"
          >${progressStepMarker(presentedStatus, sessionStatus)}</span
        >
        <span class="session-progress-card__step-text">${step.step}</span>
      </li>`;
    })}
  </ol>`;
}

function renderBody(card: ProgressCard, hasActiveRun: boolean, sessionStatus?: SessionRunStatus) {
  return html`<div class="session-progress-card__body">
    ${renderProgressCardMarkdown(card.markdown)} ${renderSteps(card, hasActiveRun, sessionStatus)}
  </div>`;
}

export function renderSessionProgressCard(
  card: ProgressCard | null | undefined,
  placement: SessionProgressCardPlacement,
  onDismiss?: (card: ProgressCard) => void,
  sessionStatus?: SessionRunStatus,
  startedAt?: number,
  endedAt?: number,
  hasActiveRun = true,
  collapseComposerByDefault = false,
  composerRunLifecycle?: ComposerProgressRunLifecycle,
) {
  if (!card) {
    return nothing;
  }
  const counts = progressCounts(card);
  const countLabel = counts
    ? t("sessionProgressCard.countLabel", {
        completed: String(counts.completed),
        total: String(counts.total),
      })
    : t("sessionProgressCard.noteLabel");
  const validStartedAt = asDateTimestampMs(startedAt);
  const validEndedAt = asDateTimestampMs(endedAt);
  const validUpdatedAt = asDateTimestampMs(card.updatedAt);
  const hasValidRunWindow =
    validStartedAt !== undefined &&
    validEndedAt !== undefined &&
    validEndedAt >= validStartedAt &&
    validUpdatedAt !== undefined &&
    validUpdatedAt >= validStartedAt;
  // A later run does not own durable progress last updated before it started.
  const effectiveHasActiveRun = hasActiveRun && !isProgressCardStaleForRun(card, startedAt);
  const terminalTimestamp =
    sessionStatus && TERMINAL_OUTCOME_LABEL_KEYS[sessionStatus] && hasValidRunWindow
      ? validEndedAt
      : undefined;
  const effectiveSessionStatus =
    sessionStatus && TERMINAL_OUTCOME_LABEL_KEYS[sessionStatus] && !terminalTimestamp
      ? undefined
      : sessionStatus;
  const activityTimestamp = terminalTimestamp ?? validUpdatedAt ?? Date.now();
  const activityKey = terminalTimestamp
    ? ACTIVITY_LABEL_KEYS[sessionStatus!]
    : "sessionProgressCard.activity.updated";
  const accessibleLabel = countLabel;
  const lastActivity = progressActivityTime(activityTimestamp, activityKey);
  const dismissible = Boolean(
    onDismiss && card.steps?.length && card.steps.every((step) => step.status === "completed"),
  );
  const dismiss = dismissible
    ? html`<button
        class="rail-header__action session-progress-card__dismiss"
        type="button"
        aria-label=${t("sessionProgressCard.dismiss")}
        title=${t("sessionProgressCard.dismiss")}
        @click=${(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          onDismiss?.(card);
        }}
      >
        ${icons.x}
      </button>`
    : nothing;
  if (placement === "composer") {
    const steps = card.steps ?? [];
    const currentStep = currentProgressStep(steps);
    const currentPosition = currentProgressPosition(steps);
    const complete = steps.length > 0 && steps.every((step) => step.status === "completed");
    const composerCountLabel = counts
      ? t("sessionProgressCard.countLabel", {
          completed: String(counts.completed),
          total: String(counts.total),
        })
      : t("sessionProgressCard.noteLabel");
    const stepLabel = currentStep?.step ?? t("sessionProgressCard.noteLabel");
    const terminalOutcomeKey = effectiveSessionStatus
      ? TERMINAL_OUTCOME_LABEL_KEYS[effectiveSessionStatus]
      : undefined;
    const summaryLabel = `${stepLabel}. ${terminalOutcomeKey ? t(terminalOutcomeKey) : countLabel}`;
    const shortCount = counts
      ? t("sessionProgressCard.shortCount", {
          completed: String(currentPosition),
          total: String(counts.total),
        })
      : nothing;
    const presentedCurrentStatus =
      currentStep?.status === "in_progress" && !effectiveHasActiveRun && !terminalOutcomeKey
        ? "paused"
        : currentStep?.status;
    const summaryIndicator =
      effectiveSessionStatus === "done"
        ? icons.check
        : effectiveSessionStatus === "failed" ||
            effectiveSessionStatus === "timeout" ||
            effectiveSessionStatus === "killed"
          ? icons.circleX
          : complete
            ? icons.check
            : currentStep?.status === "in_progress"
              ? progressStepMarker(presentedCurrentStatus ?? "pending")
              : icons.clock;
    return html`<details
      class="session-progress-card session-progress-card--composer"
      data-progress-card-placement="composer"
      data-complete=${String(complete)}
      ${ref((element) =>
        reconcileComposerDisclosure(
          element,
          card.sessionKey,
          !complete && !collapseComposerByDefault,
          collapseComposerByDefault,
          composerRunLifecycle,
        ),
      )}
    >
      <summary class="session-progress-card__summary" aria-label=${summaryLabel}>
        <span
          class="session-progress-card__summary-indicator session-progress-card__current-marker${
            complete || effectiveSessionStatus === "done"
              ? " session-progress-card__summary-indicator--complete"
              : ""
          }"
          data-status=${presentedCurrentStatus ?? "pending"}
          data-outcome=${effectiveSessionStatus ?? nothing}
          aria-hidden="true"
        >
          ${summaryIndicator}
        </span>
        <span class="session-progress-card__summary-collapsed">
          <span class="session-progress-card__current">${stepLabel}</span>
        </span>
        ${
          counts
            ? html`<span
                class="session-progress-card__summary-count session-progress-card__summary-count--collapsed"
                data-outcome=${effectiveSessionStatus ?? nothing}
                >${
                  terminalOutcomeKey ? t(terminalOutcomeKey) : `${currentPosition}/${counts.total}`
                }</span
              >`
            : nothing
        }
        <span class="session-progress-card__summary-expanded">
          <span class="session-progress-card__summary-title"
            >${t("sessionProgressCard.composerTitle")}</span
          >
          <span class="session-progress-card__heading-actions"
            ><span>${lastActivity}${counts ? html` · ${shortCount}` : nothing}</span
            >${dismiss}</span
          >
        </span>
        <span
          class="session-progress-card__summary-chevron session-progress-card__chevron"
          aria-hidden="true"
          >${icons.chevronDown}</span
        >
      </summary>
      <div class="session-progress-card__body" role="region" aria-label=${composerCountLabel}>
        ${renderProgressCardMarkdown(card.markdown)}
        ${renderSteps(card, effectiveHasActiveRun, effectiveSessionStatus)}
      </div>
    </details>`;
  }
  return html`<section
    class="session-progress-card session-progress-card--${placement}"
    data-progress-card-placement=${placement}
    aria-label=${accessibleLabel}
  >
    <div class="session-progress-card__heading">
      <span>${t("sessionProgressCard.title")}</span>
      <span class="session-progress-card__heading-actions">
        <span
          >${lastActivity}${counts ? html` · ${counts.completed}/${counts.total}` : nothing}</span
        >${dismiss}
      </span>
    </div>
    ${renderBody(card, effectiveHasActiveRun, effectiveSessionStatus)}
  </section>`;
}
