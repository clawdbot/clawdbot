import type { ProgressCard, ProgressCardStep } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
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
    const current = currentProgressStep(card.steps ?? []);
    const currentStatus = current?.status ?? "pending";
    return html`<details
      class="session-progress-card session-progress-card--composer"
      data-progress-card-placement="composer"
    >
      <summary class="session-progress-card__summary" aria-label=${accessibleLabel}>
        <span
          class="session-progress-card__current-marker"
          data-status=${currentStatus}
          aria-hidden="true"
          >${progressStepMarker(currentStatus)}</span
        >
        <span class="session-progress-card__current"
          >${current?.step ?? t("sessionProgressCard.noteLabel")}</span
        >
        <span class="session-progress-card__count"
          >${counts ? html`${counts.completed}/${counts.total} · ` : nothing}${lastActivity}</span
        >
        ${dismiss}
        <span class="session-progress-card__chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      ${renderBody(card)}
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
