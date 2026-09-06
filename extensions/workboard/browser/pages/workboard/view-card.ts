import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { clampText } from "../../lib/format.ts";
import {
  isActiveWorkboardCard,
  nextWorkboardCardPosition,
} from "../../lib/workboard/card-state.ts";
import {
  getWorkboardDependencyState,
  getWorkboardLifecycle,
  getWorkboardState,
  moveWorkboardCard,
  workboardCardMatchesHealthKey,
  type WorkboardCard,
  type WorkboardDependencyState,
  type WorkboardStatus,
  type WorkboardTaskSummary,
} from "../../lib/workboard/index.ts";
import { cardAgentLabel } from "./agent-filter.ts";
import {
  getCardActionState,
  renderArchiveCardAction,
  renderCardActionSlot,
  renderCardMoveControl,
  renderDeleteCardAction,
  renderEditCardAction,
  renderOpenSessionCardAction,
  renderStartExecutionButton,
  renderStopCardAction,
} from "./view-card-actions.ts";
import { openCardDetails, workboardCardDetailDrawerId } from "./view-card-details.ts";
import {
  canMutate,
  formatAge,
  formatDependencyBlockerTitle,
  formatEventLabel,
  formatLifecycle,
  formatPriorityLabel,
  formatStatusLabel,
  formatWorkboardDate,
  formatUpdatedTime,
  taskDetail,
  taskMatchesLifecycle,
  type WorkboardProps,
} from "./view-helpers.ts";

function renderEvents(card: WorkboardCard) {
  const events = (card.events ?? []).toReversed().slice(0, 4);
  if (events.length === 0) {
    return nothing;
  }
  return html`
    <ol class="workboard-events" aria-label=${t("workboard.eventsLabel")}>
      ${events.map(
        (event) => html`
          <li>
            <span>${formatEventLabel(event)}</span>
            <time>${formatWorkboardDate(event.at)}</time>
          </li>
        `,
      )}
    </ol>
  `;
}

function renderCountBadge(labelKey: string, count: number) {
  return html`<span>${t(labelKey, { count: String(count) })}</span>`;
}

function renderCompactBadges(card: WorkboardCard, task?: WorkboardTaskSummary) {
  const metadata = card.metadata;
  const badges: TemplateResult[] = [];
  const latestDiagnostic = metadata?.diagnostics?.toSorted(
    (left, right) => right.lastSeenAt - left.lastSeenAt,
  )[0];
  const blockedReason =
    card.status === "blocked"
      ? (metadata?.notifications?.at(-1)?.message ??
        metadata?.workerProtocol?.detail ??
        latestDiagnostic?.detail)
      : undefined;
  if (metadata?.templateId) {
    badges.push(html`<span>${t(`workboard.template.${metadata.templateId}`)}</span>`);
  }
  if (task ?? card.taskId) {
    badges.push(html`<span>${t("workboard.badgeTaskLinked")}</span>`);
  }
  if (metadata?.attempts?.length) {
    badges.push(renderCountBadge("workboard.badgeAttempts", metadata.attempts.length));
  }
  if (metadata?.failureCount) {
    badges.push(html`
      <span class="workboard-card__badge--warning">
        ${icons.alertTriangle}${t("workboard.badgeFailures", {
          count: String(metadata.failureCount),
        })}
      </span>
    `);
  }
  if (metadata?.comments?.length) {
    badges.push(renderCountBadge("workboard.badgeComments", metadata.comments.length));
  }
  if (metadata?.proof?.length) {
    badges.push(renderCountBadge("workboard.badgeProof", metadata.proof.length));
  }
  if (metadata?.claim) {
    badges.push(
      html`<span>${t("workboard.badgeClaimed", { owner: metadata.claim.ownerId })}</span>`,
    );
    const heartbeatAge = formatAge(metadata.claim.lastHeartbeatAt);
    if (heartbeatAge) {
      badges.push(html`<span>${t("workboard.badgeHeartbeat", { age: heartbeatAge })}</span>`);
    }
  }
  if (latestDiagnostic) {
    badges.push(
      html`<span
        class="workboard-card__badge--warning"
        title=${formatUiExternalText(latestDiagnostic.detail)}
      >
        ${icons.alertTriangle}${clampText(latestDiagnostic.title.trim(), 64)}
      </span>`,
    );
  }
  if (blockedReason) {
    badges.push(
      html`<span
        class="workboard-card__badge--warning"
        title=${formatUiExternalText(blockedReason)}
      >
        ${icons.alertTriangle}${clampText(formatUiExternalText(blockedReason), 64)}
      </span>`,
    );
  }
  if (metadata?.stale) {
    badges.push(
      html`<span class="workboard-card__badge--warning"
        >${icons.alertTriangle}${t("workboard.badgeStale")}</span
      >`,
    );
  }
  return badges.length ? html` <div class="workboard-card__badges">${badges}</div> ` : nothing;
}

function isCardActionTarget(event: Event): boolean {
  return event.target instanceof Element
    ? Boolean(event.target.closest("button, a, input, select, textarea"))
    : false;
}

function renderAgentChip(props: WorkboardProps, card: WorkboardCard) {
  const label = cardAgentLabel(card, props.agentsList);
  const title = card.agentId
    ? t("workboard.agentLinked", { agent: label })
    : t("workboard.agentDefaultLinked", { agent: label });
  return html`<span class="workboard-agent-chip" title=${title}>${label}</span>`;
}

function renderDependencyBadges(dependencies: WorkboardDependencyState) {
  if (dependencies.parents.length === 0) {
    return nothing;
  }
  const blocked = dependencies.blockedParents.length;
  const title =
    formatDependencyBlockerTitle(dependencies) ??
    t("workboard.dependenciesReadyTitle", { count: String(dependencies.parents.length) });
  return html`
    <div class="workboard-dependencies" title=${title}>
      ${
        blocked > 0
          ? html`
              <span class="workboard-dependency workboard-dependency--blocked">
                ${icons.alertTriangle}${t("workboard.dependenciesBlocked", {
                  count: String(blocked),
                })}
              </span>
            `
          : html`
              <span class="workboard-dependency workboard-dependency--ready">
                ${t("workboard.dependenciesReady", { count: String(dependencies.parents.length) })}
              </span>
            `
      }
    </div>
  `;
}

function renderLifecycle(
  card: WorkboardCard,
  props: Pick<WorkboardProps, "sessions" | "sessionResolution">,
  task?: WorkboardTaskSummary,
) {
  const lifecycle = getWorkboardLifecycle(card, props.sessions, task, props.sessionResolution);
  const formatted = formatLifecycle(lifecycle);
  const stale = lifecycle.state === "stale";
  const taskIsAuthoritative = task ? taskMatchesLifecycle(task, lifecycle) : false;
  const taskStatus = task && taskIsAuthoritative ? t(`workboard.taskStatus.${task.status}`) : null;
  return html`
    <div class="workboard-card__lifecycle">
      <span class="workboard-lifecycle workboard-lifecycle--${formatted.tone}">
        ${
          taskStatus ??
          (stale || !card.execution
            ? formatted.label
            : `${card.execution.engine ? `${card.execution.engine} ` : ""}${card.execution.mode}`)
        }
      </span>
      <span class="workboard-card__lifecycle-detail">
        ${
          task && taskIsAuthoritative
            ? taskDetail(task)
            : stale
              ? formatted.detail
              : (lifecycle.session?.displayName ?? lifecycle.session?.label ?? formatted.detail)
        }
      </span>
    </div>
  `;
}

type WorkboardCardSurface = "page" | "widget";

function renderCard(props: WorkboardProps, card: WorkboardCard, surface: WorkboardCardSurface) {
  const {
    state,
    task,
    busy,
    activeTask,
    live,
    linkedSessionKey,
    sessionTarget,
    writable,
    showStartControls,
    archived,
  } = getCardActionState(props, card);
  const widget = surface === "widget";
  const healthHighlighted = state.activeHealthHighlight
    ? workboardCardMatchesHealthKey(card, state.activeHealthHighlight, props.sessions, task)
    : false;
  const dependencies = getWorkboardDependencyState(card, state.cards);
  const topStartAction =
    !widget && showStartControls
      ? renderStartExecutionButton(props, card, null, "autonomous", { iconOnly: true })
      : nothing;
  const topEditAction =
    !widget && writable && !archived
      ? renderEditCardAction(props, card, { iconOnly: true })
      : nothing;
  const topArchiveAction =
    !widget && writable
      ? renderArchiveCardAction(props, card, busy, archived, { iconOnly: true })
      : nothing;
  const detailAction = widget
    ? nothing
    : html`
        <span title=${t("workboard.viewDetails")}>
          <button
            class="btn btn--icon workboard-card__icon"
            aria-label=${t("workboard.viewDetails")}
            aria-haspopup="dialog"
            aria-expanded=${state.detailCardId === card.id ? "true" : "false"}
            aria-controls=${workboardCardDetailDrawerId}
            @click=${() => {
              openCardDetails(state, card);
              props.onRequestUpdate?.();
            }}
          >
            ${icons.panelRightOpen}
          </button>
        </span>
      `;
  const sessionAction = widget
    ? nothing
    : renderOpenSessionCardAction(props, sessionTarget, { iconOnly: true });
  const stopAction =
    !widget && writable && (linkedSessionKey ? live : activeTask)
      ? renderStopCardAction(props, card, busy, { iconOnly: true })
      : nothing;
  const moveAction =
    !archived && (writable || widget)
      ? renderCardMoveControl(props, card, busy || !writable, { wide: widget })
      : nothing;
  const deleteAction =
    !widget && writable ? renderDeleteCardAction(props, card, busy, { iconOnly: true }) : nothing;
  return html`
    <article
      class="workboard-card priority-${card.priority} ${
        busy ? "workboard-card--busy" : ""
      } ${archived ? "workboard-card--archived" : ""}
      ${state.draggedCardId === card.id ? "workboard-card--dragging" : ""} ${
        healthHighlighted
          ? `workboard-card--health-highlight workboard-card--health-highlight-${state.activeHealthHighlight}`
          : ""
      } ${widget ? "workboard-card--widget" : "workboard-card--openable"}"
      role=${widget ? nothing : "button"}
      tabindex=${widget ? nothing : "0"}
      title=${widget ? nothing : t("workboard.viewDetails")}
      aria-haspopup=${widget ? nothing : "dialog"}
      aria-expanded=${widget ? nothing : state.detailCardId === card.id ? "true" : "false"}
      aria-controls=${widget ? nothing : workboardCardDetailDrawerId}
      draggable=${writable && !archived && !state.dispatching ? "true" : "false"}
      @click=${(event: MouseEvent) => {
        if (!widget && !isCardActionTarget(event)) {
          openCardDetails(state, card);
          props.onRequestUpdate?.();
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (widget || isCardActionTarget(event) || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        openCardDetails(state, card);
        props.onRequestUpdate?.();
        event.preventDefault();
      }}
      @dragstart=${(event: DragEvent) => {
        if (!writable || archived || state.dispatching) {
          event.preventDefault();
          return;
        }
        state.draggedCardId = card.id;
        event.dataTransfer?.setData("text/plain", card.id);
        event.dataTransfer?.setDragImage(event.currentTarget as Element, 16, 16);
        props.onRequestUpdate?.();
      }}
      @dragend=${() => {
        state.draggedCardId = null;
        props.onRequestUpdate?.();
      }}
    >
      <div class="workboard-card__top">
        <div
          class="workboard-card__updated"
          title=${t("workboard.detailUpdatedValue", { time: formatUpdatedTime(card.updatedAt) })}
          aria-label=${t("workboard.detailUpdatedValue", {
            time: formatUpdatedTime(card.updatedAt),
          })}
        >
          <span class="workboard-card__updated-icon" aria-hidden="true">${icons.clock}</span>
          <span>${formatUpdatedTime(card.updatedAt)}</span>
        </div>
        <div class="workboard-card__quick-actions">
          ${renderCardActionSlot(topStartAction)} ${renderCardActionSlot(topEditAction)}
          ${renderCardActionSlot(topArchiveAction)}
        </div>
      </div>
      <div class="workboard-card__chips">
        <span class="workboard-card__priority">${formatPriorityLabel(card.priority)}</span>
        ${renderAgentChip(props, card)}
        ${
          archived
            ? html`<span class="workboard-card__archived">${t("workboard.archived")}</span>`
            : nothing
        }
        ${live ? html`<span class="workboard-live">${t("workboard.live")}</span>` : nothing}
      </div>
      <h3>${card.title}</h3>
      ${card.notes ? html`<p>${card.notes}</p>` : nothing} ${renderLifecycle(card, props, task)}
      ${renderDependencyBadges(dependencies)}
      ${
        card.labels.length
          ? html`<div class="workboard-labels">
              ${card.labels.map((label) => html`<span>${label}</span>`)}
            </div>`
          : nothing
      }
      ${renderCompactBadges(card, task)}
      <div class="workboard-card__meta">
        <span>${linkedSessionKey ?? t("workboard.noLinkedSession")}</span>
      </div>
      ${renderEvents(card)}
      ${
        widget
          ? html`<div class="workboard-card__actions workboard-card__actions--widget">
              ${moveAction}
            </div>`
          : html`<div class="workboard-card__actions">
              ${renderCardActionSlot(detailAction)}
              <div class="workboard-card__actions-primary">
                ${renderCardActionSlot(sessionAction)} ${renderCardActionSlot(stopAction)}
                ${renderCardActionSlot(moveAction)}
              </div>
              ${renderCardActionSlot(deleteAction)}
            </div>`
      }
    </article>
  `;
}

export function renderColumn(
  props: WorkboardProps,
  status: WorkboardStatus,
  cards: WorkboardCard[],
  options: { surface?: WorkboardCardSurface } = {},
) {
  const state = getWorkboardState(props.host);
  const writable = canMutate(props);
  const surface = options.surface ?? "page";
  const collapsible = surface === "page";
  const label = formatStatusLabel(status);
  const autoCollapsed =
    state.emptyColumnMode === "collapse" &&
    cards.length === 0 &&
    !state.expandedEmptyStatuses.has(status);
  const collapsed = collapsible && (state.collapsedStatuses.has(status) || autoCollapsed);
  const expandColumn = () => {
    state.collapsedStatuses.delete(status);
    if (cards.length === 0) {
      state.expandedEmptyStatuses.add(status);
    }
    props.onRequestUpdate?.();
  };
  const collapseColumn = () => {
    state.collapsedStatuses.add(status);
    state.expandedEmptyStatuses.delete(status);
    props.onRequestUpdate?.();
  };
  return html`
    <section
      class="workboard-column workboard-column--${status} ${
        state.draggedCardId ? "workboard-column--drop" : ""
      } ${collapsed ? "workboard-column--collapsed" : ""}"
      aria-label=${`${label}, ${cards.length}`}
      @dragover=${(event: DragEvent) => {
        if (writable && state.draggedCardId) {
          event.preventDefault();
        }
      }}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        if (!writable) {
          return;
        }
        const cardId = event.dataTransfer?.getData("text/plain") || state.draggedCardId;
        const card = state.cards.find((candidate) => candidate.id === cardId);
        if (!card || !isActiveWorkboardCard(card)) {
          return;
        }
        void moveWorkboardCard({
          host: props.host,
          client: props.client,
          cardId: card.id,
          status,
          position: nextWorkboardCardPosition(state.cards, card, status),
          requestUpdate: props.onRequestUpdate,
        });
      }}
    >
      ${
        collapsed
          ? html`
              <button
                class="workboard-column__rail"
                type="button"
                aria-label=${t("workboard.expandColumn", { column: label })}
                aria-expanded="false"
                @click=${expandColumn}
              >
                <span class="workboard-column__rail-title">${label}</span>
                <span class="workboard-column__count">${cards.length}</span>
                <span class="workboard-column__rail-icon" aria-hidden="true">
                  <span
                    class="workboard-column__direction-icon workboard-column__direction-icon--expand-horizontal"
                    >${icons.panelRightClose}</span
                  >
                  <span
                    class="workboard-column__direction-icon workboard-column__direction-icon--expand-vertical"
                    >${icons.panelBottomOpen}</span
                  >
                </span>
              </button>
            `
          : html`
              <div class="workboard-column__header">
                <h2>${label}</h2>
                ${
                  collapsible
                    ? html`
                        <div class="workboard-column__header-actions">
                          <span class="workboard-column__count">${cards.length}</span>
                          <span title=${t("workboard.collapseColumn", { column: label })}>
                            <button
                              class="btn btn--icon workboard-column__collapse"
                              type="button"
                              aria-label=${t("workboard.collapseColumn", { column: label })}
                              aria-expanded="true"
                              @click=${collapseColumn}
                            >
                              <span class="workboard-column__collapse-icon" aria-hidden="true">
                                <span
                                  class="workboard-column__direction-icon workboard-column__direction-icon--collapse-horizontal"
                                  >${icons.panelRightOpen}</span
                                >
                                <span
                                  class="workboard-column__direction-icon workboard-column__direction-icon--collapse-vertical"
                                  >${icons.panelBottomClose}</span
                                >
                              </span>
                            </button>
                          </span>
                        </div>
                      `
                    : html`<span class="workboard-column__count">${cards.length}</span>`
                }
              </div>
              <div class="workboard-column__cards">
                ${
                  cards.length
                    ? cards.map((card) => renderCard(props, card, surface))
                    : html`<div class="workboard-empty">${t("workboard.emptyColumn")}</div>`
                }
              </div>
            `
      }
    </section>
  `;
}
