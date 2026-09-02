import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import {
  workboardCardBoardId,
  matchesBoardFilter,
  WORKBOARD_ALL_BOARDS_FILTER,
} from "../lib/workboard/board-filter.ts";
import {
  WORKBOARD_STATUSES,
  type WorkboardCard,
  type WorkboardStatus,
} from "../lib/workboard/types.ts";
import { renderColumn } from "../pages/workboard/view-card.ts";
import type { WorkboardProps } from "../pages/workboard/view-helpers.ts";
import { workboardPageTarget } from "../pages/workboard/workboard-page.ts";
import type { WorkboardWidgetModel } from "./runtime.ts";

function renderAvailability(model: WorkboardWidgetModel): TemplateResult | null {
  if (!model.connected) {
    return html`<p class="workboard-widget__state" role="status">
      ${t("workboard.widget.disconnected")}
    </p>`;
  }
  if (!model.loaded && !model.error) {
    return html`<p class="workboard-widget__state">${t("workboard.widget.loading")}</p>`;
  }
  if (model.error) {
    return html`<div class="workboard-widget__state" role="alert">
      <span>${model.error}</span>
      <button class="btn btn--sm" type="button" @click=${() => model.retryLoad()}>
        ${t("common.retry")}
      </button>
    </div>`;
  }
  return null;
}

export function renderWorkboardMiniWidget(model: WorkboardWidgetModel): TemplateResult {
  const availability = renderAvailability(model);
  if (availability) {
    return availability;
  }
  // No boardId prop means every board: silently scoping to "default" hides
  // cards created with an explicit board id and renders an all-zero widget.
  const boardId = model.readStringProp("boardId");
  const limit = Math.min(10, model.readPositiveIntegerProp("limit", 5));
  const cards = boardId
    ? model.cards.filter((card) => workboardCardBoardId(card) === boardId)
    : model.cards;
  const topCards = cards
    .filter((card) => card.status === "ready" || card.status === "running")
    .toSorted(
      (left, right) =>
        Number(right.status === "running") - Number(left.status === "running") ||
        left.position - right.position ||
        left.title.localeCompare(right.title),
    )
    .slice(0, limit);
  const workboardPath = model.host.navigation.pageHref(workboardPageTarget(boardId));
  return html`
    <section class="workboard-widget-mini" data-test-id="workboard-mini-widget">
      <header>
        <strong>${boardId ?? t("workboard.allBoards")}</strong>
        <a href=${workboardPath}>${t("workboard.widget.openBoard")}</a>
      </header>
      <div class="workboard-widget-mini__counts" aria-label=${t("workboard.widget.statusCounts")}>
        ${WORKBOARD_STATUSES.map(
          (status) => html`
            <span title=${t(`workboard.status.${status}`)}>
              <b>${cards.filter((card) => card.status === status).length}</b>
              ${t(`workboard.status.${status}`)}
            </span>
          `,
        )}
      </div>
      <div class="workboard-widget-mini__cards">
        ${topCards.length > 0
          ? topCards.map(
              (card) => html`
                <div class="workboard-widget-mini__card">
                  <span
                    class=${`workboard-widget__status workboard-widget__status--${card.status}`}
                  >
                    ${t(`workboard.status.${card.status}`)}
                  </span>
                  <strong>${card.title}</strong>
                </div>
              `,
            )
          : html`<p class="workboard-widget__state">${t("workboard.widget.noActiveCards")}</p>`}
      </div>
    </section>
  `;
}

export function renderWorkboardCardWidget(model: WorkboardWidgetModel): TemplateResult {
  const cardId = model.readStringProp("cardId");
  if (!cardId) {
    return html`<p class="workboard-widget__state" role="alert">
      ${t("workboard.widget.cardIdRequired")}
    </p>`;
  }
  const availability = renderAvailability(model);
  if (availability) {
    return availability;
  }
  const card = model.cards.find((candidate) => candidate.id === cardId);
  if (!card) {
    return html`<p class="workboard-widget__state">${t("workboard.widget.cardMissing")}</p>`;
  }
  const statuses = model.statuses.includes(card.status)
    ? model.statuses
    : [card.status, ...model.statuses];
  const priority = card.priority.charAt(0).toUpperCase() + card.priority.slice(1);
  return html`
    <article class="workboard-widget-card" data-test-id="workboard-card-widget">
      <div class="workboard-widget-card__heading">
        <strong>${card.title}</strong>
        <span class=${`workboard-widget__status workboard-widget__status--${card.status}`}>
          ${t(`workboard.status.${card.status}`)}
        </span>
      </div>
      <dl class="workboard-widget-card__meta">
        <div>
          <dt>${t("workboard.fieldPriority")}</dt>
          <dd>${priority}</dd>
        </div>
        <div>
          <dt>${t("workboard.fieldAgent")}</dt>
          <dd>${card.agentId ?? t("workboard.widget.unassigned")}</dd>
        </div>
      </dl>
      ${statuses.length > 1
        ? html`
            <label class="workboard-widget-card__move">
              <span>${t("workboard.fieldStatus")}</span>
              <select
                aria-label=${`${t("workboard.fieldStatus")}: ${card.title}`}
                .value=${card.status}
                ?disabled=${!model.canMutate}
                @change=${(event: Event) => void model.handleStatusChange(event)}
              >
                ${statuses.map(
                  (status) => html`
                    <option value=${status} ?selected=${status === card.status}>
                      ${t(`workboard.status.${status}`)}
                    </option>
                  `,
                )}
              </select>
            </label>
          `
        : nothing}
    </article>
  `;
}

export function renderWorkboardBoardWidget(model: WorkboardWidgetModel): TemplateResult {
  const availability = renderAvailability(model);
  if (availability) {
    return availability;
  }

  // No boardId prop means every board, matching the summary widget. Defaulting
  // here would silently hide cards owned by explicitly named boards.
  const boardId = model.readStringProp("boardId");
  const filter = boardId ?? WORKBOARD_ALL_BOARDS_FILTER;
  const cards = model.cards.filter((card) => matchesBoardFilter(card, filter));
  const byStatus = new Map<WorkboardStatus, WorkboardCard[]>();
  for (const status of model.statuses) {
    byStatus.set(status, []);
  }
  for (const card of cards) {
    byStatus.get(card.status)?.push(card);
  }

  // Hidden widgets retain their controls; mutation admission must follow the current lease.
  const props: WorkboardProps = {
    host: model.workboardStateHost,
    get client() {
      return model.workboardClient;
    },
    get connected() {
      return model.connected;
    },
    get canWrite() {
      return model.canMutate;
    },
    agentsList: null,
    sessions: [],
    onOpenSession: model.host.sessions.open,
    onRequestUpdate: () => model.syncFromHost(),
  };
  const workboardPath = model.host.navigation.pageHref(workboardPageTarget(boardId));

  return html`
    <section class="workboard-widget-board" data-test-id="workboard-board-widget">
      <header class="workboard-widget-board__header">
        <strong>${boardId ?? t("workboard.allBoards")}</strong>
        <span>${t("workboard.widget.cardCount", { count: String(cards.length) })}</span>
        <a href=${workboardPath}>${t("workboard.widget.openBoard")}</a>
      </header>
      <div class="workboard-board workboard-board--compact workboard-widget-board__columns">
        ${model.statuses.map((status) =>
          renderColumn(props, status, byStatus.get(status) ?? [], { surface: "widget" }),
        )}
      </div>
    </section>
  `;
}
