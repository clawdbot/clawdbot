import { html, nothing } from "lit";
import type { PlanStatus } from "../tool-stream.ts";

type ChatPlanChecklistVariant = "bar" | "card";

type ChatPlanChecklistOptions = {
  active: boolean;
  variant: ChatPlanChecklistVariant;
};

function renderPlanChecklistBody(status: PlanStatus) {
  const statusLabels: Record<PlanStatus["steps"][number]["status"], string> = {
    completed: "completed",
    in_progress: "in progress",
    pending: "pending",
  };
  return html`
    <div class="plan-checklist__body">
      ${status.explanation
        ? html`<div class="plan-checklist__explanation">${status.explanation}</div>`
        : nothing}
      <ol class="plan-checklist__steps">
        ${status.steps.map(
          (step) => html`
            <li
              class=${`plan-checklist__step plan-checklist__step--${step.status}`}
              aria-label=${`${step.step}, ${statusLabels[step.status]}`}
            >
              <span class="plan-checklist__step-marker" aria-hidden="true"
                >${step.status === "completed"
                  ? "✓"
                  : step.status === "in_progress"
                    ? "▸"
                    : "▢"}</span
              >
              <span class="plan-checklist__step-text">${step.step}</span>
            </li>
          `,
        )}
      </ol>
    </div>
  `;
}

export function renderChatPlanChecklist(
  status: PlanStatus | null | undefined,
  options: ChatPlanChecklistOptions,
) {
  if (!options.active || !status || status.steps.length === 0) {
    return nothing;
  }
  const completed = status.steps.filter((step) => step.status === "completed").length;
  let current = status.steps.find((step) => step.status === "in_progress");
  if (!current) {
    for (let index = status.steps.length - 1; index >= 0; index -= 1) {
      const step = status.steps[index];
      if (step?.status === "completed") {
        current = step;
        break;
      }
    }
  }
  current ??= status.steps[0];
  if (!current) {
    return nothing;
  }
  const label = `Plan: ${current.step}. ${completed} of ${status.steps.length} completed`;
  const summary = html`
    <span class="plan-checklist__current-marker" aria-hidden="true">▸</span>
    <span class="plan-checklist__current">${current.step}</span>
    <span class="plan-checklist__count">${completed}/${status.steps.length}</span>
  `;
  const body = renderPlanChecklistBody(status);

  if (options.variant === "card") {
    return html`
      <section class="plan-checklist plan-checklist--card" aria-label=${label}>
        <div class="plan-checklist__summary">${summary}</div>
        ${body}
      </section>
    `;
  }
  return html`
    <details class="plan-checklist plan-checklist--bar">
      <summary class="plan-checklist__summary" aria-label=${label}>${summary}</summary>
      ${body}
    </details>
  `;
}
