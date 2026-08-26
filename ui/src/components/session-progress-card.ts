import type { ProgressCard, ProgressCardStep } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../i18n/index.ts";
import { formatTimeMs } from "../lib/format.ts";
import { icons } from "./icons.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

type SessionProgressCardPlacement = "board" | "composer" | "dock" | "hovercard" | "rail";

const STATUS_LABEL_KEYS: Record<ProgressCardStep["status"], Parameters<typeof t>[0]> = {
  completed: "sessionProgressCard.status.completed",
  in_progress: "sessionProgressCard.status.inProgress",
  pending: "sessionProgressCard.status.pending",
};

const composerDisclosureOwners = new WeakMap<HTMLDetailsElement, string>();

function initializeComposerDisclosure(
  element: Element | undefined,
  sessionKey: string,
  open: boolean,
): void {
  if (
    !(element instanceof HTMLDetailsElement) ||
    composerDisclosureOwners.get(element) === sessionKey
  ) {
    return;
  }
  // The native disclosure owns later toggles; progress rerenders must not
  // overwrite the operator's open/closed choice.
  element.open = open;
  composerDisclosureOwners.set(element, sessionKey);
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

function currentProgressStep(steps: readonly ProgressCardStep[]): ProgressCardStep | undefined {
  return (
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending") ??
    steps.findLast((step) => step.status === "completed")
  );
}

function progressStepMarker(status: ProgressCardStep["status"]) {
  switch (status) {
    case "completed":
      return icons.check;
    case "in_progress":
      return html`<span class="session-run-spinner"></span>`;
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

function renderMarkdown(markdown: string | undefined) {
  if (!markdown) {
    return nothing;
  }
  return html`<div class="session-progress-card__markdown sidebar-markdown">
    ${unsafeHTML(toSanitizedMarkdownHtml(markdown, { progressBars: true }))}
  </div>`;
}

function renderSteps(card: ProgressCard) {
  const steps = card.steps;
  if (!steps?.length) {
    return nothing;
  }
  return html`<ol class="session-progress-card__steps">
    ${steps.map((step) => {
      const statusLabel = t(STATUS_LABEL_KEYS[step.status]);
      return html`<li
        class="session-progress-card__step session-progress-card__step--${step.status}"
        aria-label=${t("sessionProgressCard.stepLabel", { status: statusLabel, step: step.step })}
      >
        <span
          class="session-progress-card__step-marker"
          data-status=${step.status}
          aria-hidden="true"
          >${progressStepMarker(step.status)}</span
        >
        <span class="session-progress-card__step-text">${step.step}</span>
      </li>`;
    })}
  </ol>`;
}

function renderBody(card: ProgressCard) {
  return html`<div class="session-progress-card__body">
    ${renderMarkdown(card.markdown)} ${renderSteps(card)}
  </div>`;
}

export function renderSessionProgressCard(
  card: ProgressCard | null | undefined,
  placement: SessionProgressCardPlacement,
  onDismiss?: (card: ProgressCard) => void,
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
  const activityTime = formatTimeMs(card.updatedAt, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const activityLabel = t("sessionProgressCard.lastActivity", { time: activityTime });
  const accessibleLabel = `${countLabel}. ${activityLabel}`;
  const lastActivity = html`<time
    datetime=${new Date(card.updatedAt).toISOString()}
    aria-label=${activityLabel}
    title=${activityLabel}
    >${activityTime}</time
  >`;
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
    const shortCount = counts
      ? t("sessionProgressCard.shortCount", {
          completed: String(currentPosition),
          total: String(counts.total),
        })
      : nothing;
    const summaryIndicator = complete
      ? icons.check
      : currentStep?.status === "in_progress"
        ? html`<span class="session-run-spinner"></span>`
        : icons.clock;
    return html`<details
      class="session-progress-card session-progress-card--composer"
      data-progress-card-placement="composer"
      data-complete=${String(complete)}
      ${ref((element) => initializeComposerDisclosure(element, card.sessionKey, !complete))}
    >
      <summary class="session-progress-card__summary" aria-label=${accessibleLabel}>
        <span
          class="session-progress-card__summary-indicator session-progress-card__current-marker${complete
            ? " session-progress-card__summary-indicator--complete"
            : ""}"
          data-status=${currentStep?.status ?? "pending"}
          aria-hidden="true"
        >
          ${summaryIndicator}
        </span>
        <span class="session-progress-card__summary-collapsed">
          <span class="session-progress-card__current">${stepLabel}</span>
          ${counts
            ? html`<span class="session-progress-card__summary-count"
                >${currentPosition}/${counts.total}</span
              >`
            : nothing}
        </span>
        <span class="session-progress-card__summary-expanded">
          <span class="session-progress-card__summary-title"
            >${t("sessionProgressCard.composerTitle")}</span
          >
          <span class="session-progress-card__heading-actions"
            >${lastActivity} ${shortCount}${dismiss}</span
          >
        </span>
        <span
          class="session-progress-card__summary-chevron session-progress-card__chevron"
          aria-hidden="true"
          >${icons.chevronDown}</span
        >
      </summary>
      <div class="session-progress-card__body" role="region" aria-label=${composerCountLabel}>
        ${renderMarkdown(card.markdown)} ${renderSteps(card)}
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
        ${lastActivity} ${counts ? html`<span>${counts.completed}/${counts.total}</span>` : nothing}
        ${dismiss}
      </span>
    </div>
    ${renderBody(card)}
  </section>`;
}
