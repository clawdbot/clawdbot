import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  isActiveWorkboardCard,
  nextWorkboardCardPosition,
} from "../../lib/workboard/card-state.ts";
import {
  archiveWorkboardCard,
  deleteWorkboardCard,
  findWorkboardSession,
  getWorkboardState,
  moveWorkboardCard,
  startWorkboardCard,
  stopWorkboardCard,
  type WorkboardCard,
  type WorkboardExecutionEngine,
  type WorkboardExecutionMode,
  type WorkboardStatus,
} from "../../lib/workboard/index.ts";
import { openEditModal } from "./view-card-modal.ts";
import {
  canMutate,
  cardCanStart,
  cardHasActiveOrRunningUnresolvedTask,
  cardHasUnresolvedStartedRun,
  engineBlockedByRuntime,
  formatStatusLabel,
  type WorkboardProps,
} from "./view-helpers.ts";

function moveCardToStatus(props: WorkboardProps, card: WorkboardCard, status: WorkboardStatus) {
  const state = getWorkboardState(props.host);
  if (
    !isActiveWorkboardCard(card) ||
    status === card.status ||
    state.busyCardIds.has(card.id) ||
    state.dispatching ||
    !canMutate(props) ||
    !props.connected ||
    !props.client
  ) {
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
}

export function renderCardMoveControl(
  props: WorkboardProps,
  card: WorkboardCard,
  busy: boolean,
  options: { wide?: boolean } = {},
) {
  const state = getWorkboardState(props.host);
  const statuses = state.statuses.includes(card.status)
    ? state.statuses
    : [card.status, ...state.statuses];
  if (!isActiveWorkboardCard(card) || statuses.length < 2) {
    return nothing;
  }
  return html`
    <label
      class="workboard-card__move ${options.wide ? "workboard-card__move--wide" : ""}"
      title=${t("workboard.fieldStatus")}
    >
      <span class="workboard-card__move-icon" aria-hidden="true">${icons.cornerDownRight}</span>
      <select
        class="workboard-card__move-select"
        aria-keyshortcuts="ArrowLeft ArrowRight"
        aria-label=${`${t("workboard.fieldStatus")}: ${card.title}`}
        .value=${card.status}
        ?disabled=${busy || !props.connected || !props.client}
        @change=${(event: Event) => {
          moveCardToStatus(
            props,
            card,
            (event.currentTarget as HTMLSelectElement).value as WorkboardStatus,
          );
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
          }
          if (
            state.busyCardIds.has(card.id) ||
            state.dispatching ||
            !props.connected ||
            !props.client
          ) {
            event.preventDefault();
            return;
          }
          const offset = event.key === "ArrowRight" ? 1 : -1;
          const status = statuses[statuses.indexOf(card.status) + offset];
          if (!status) {
            return;
          }
          event.preventDefault();
          moveCardToStatus(props, card, status);
        }}
      >
        ${statuses.map(
          (status) => html`<option value=${status} ?selected=${status === card.status}>
            ${formatStatusLabel(status)}
          </option>`,
        )}
      </select>
    </label>
  `;
}

export function renderCardActionSlot(content: TemplateResult | typeof nothing) {
  return html`
    <span class="workboard-card__action-slot">
      ${content === nothing
        ? html`<span class="workboard-card__action-placeholder" aria-hidden="true"></span>`
        : content}
    </span>
  `;
}

export function getCardActionState(props: WorkboardProps, card: WorkboardCard) {
  const state = getWorkboardState(props.host);
  const task = state.tasksByCardId.get(card.id);
  const session = findWorkboardSession(card, props.sessions);
  const busy = state.busyCardIds.has(card.id) || state.dispatching;
  const activeTask = cardHasActiveOrRunningUnresolvedTask(card, task, state.missingTaskIds);
  const writable = canMutate(props);
  const live =
    activeTask ||
    cardHasUnresolvedStartedRun(card) ||
    session?.hasActiveRun === true ||
    (session?.hasActiveRun !== false && session?.status === "running");
  return {
    state,
    task,
    busy,
    activeTask,
    live,
    linkedSessionKey: card.sessionKey ?? card.execution?.sessionKey,
    writable,
    showStartControls: writable && cardCanStart(state, props.sessions, card),
    archived: Boolean(card.metadata?.archivedAt),
  };
}

function renderCardActionButton(params: {
  label: string;
  icon: TemplateResult;
  iconOnly?: boolean;
  className?: string;
  disabled?: boolean;
  ariaHaspopup?: "dialog";
  onClick: (event: MouseEvent) => void;
}) {
  const button = html`
    <button
      class=${params.iconOnly
        ? `btn btn--icon workboard-card__icon ${params.className ?? ""}`
        : `btn ${params.className ?? ""}`}
      type="button"
      aria-label=${params.label}
      aria-haspopup=${params.ariaHaspopup ?? nothing}
      ?disabled=${params.disabled}
      @click=${params.onClick}
    >
      ${params.icon}${params.iconOnly ? nothing : html`<span>${params.label}</span>`}
    </button>
  `;
  return params.iconOnly
    ? html`<openclaw-tooltip .content=${params.label}>${button}</openclaw-tooltip>`
    : button;
}

export function renderEditCardAction(
  props: WorkboardProps,
  card: WorkboardCard,
  options: { iconOnly?: boolean } = {},
) {
  const state = getWorkboardState(props.host);
  return renderCardActionButton({
    label: t("workboard.editCard"),
    icon: icons.edit,
    iconOnly: options.iconOnly,
    ariaHaspopup: "dialog",
    disabled: state.dispatching,
    onClick: () => {
      openEditModal(state, card);
      props.onRequestUpdate?.();
    },
  });
}

export function renderArchiveCardAction(
  props: WorkboardProps,
  card: WorkboardCard,
  busy: boolean,
  archived: boolean,
  options: { iconOnly?: boolean } = {},
) {
  const label = archived ? t("workboard.unarchiveCard") : t("workboard.archiveCard");
  return renderCardActionButton({
    label,
    icon: archived ? icons.archiveRestore : icons.archive,
    iconOnly: options.iconOnly,
    disabled: busy,
    onClick: () => {
      void archiveWorkboardCard({
        host: props.host,
        client: props.client,
        cardId: card.id,
        archived: !archived,
        requestUpdate: props.onRequestUpdate,
      });
    },
  });
}

export function renderOpenSessionCardAction(
  props: WorkboardProps,
  linkedSessionKey: string | undefined,
  options: { iconOnly?: boolean } = {},
) {
  if (!linkedSessionKey) {
    return nothing;
  }
  return renderCardActionButton({
    label: t("workboard.openSession"),
    icon: icons.messageSquare,
    iconOnly: options.iconOnly,
    onClick: () => props.onOpenSession(linkedSessionKey),
  });
}

export function renderStopCardAction(
  props: WorkboardProps,
  card: WorkboardCard,
  busy: boolean,
  options: { iconOnly?: boolean } = {},
) {
  return renderCardActionButton({
    label: t("workboard.stopSession"),
    icon: icons.stop,
    iconOnly: options.iconOnly,
    disabled: busy || !props.connected,
    onClick: () => {
      void stopWorkboardCard({
        host: props.host,
        client: props.client,
        card,
        requestUpdate: props.onRequestUpdate,
      });
    },
  });
}

export function renderDeleteCardAction(
  props: WorkboardProps,
  card: WorkboardCard,
  busy: boolean,
  options: { iconOnly?: boolean } = {},
) {
  return renderCardActionButton({
    label: t("workboard.deleteCard"),
    icon: icons.trash,
    iconOnly: options.iconOnly,
    className: "workboard-card__delete",
    disabled: busy,
    onClick: () => {
      void deleteWorkboardCard({
        host: props.host,
        client: props.client,
        cardId: card.id,
        requestUpdate: props.onRequestUpdate,
      });
    },
  });
}

function renderEngineMark(engine: WorkboardExecutionEngine) {
  return html`
    <span class="workboard-engine-mark workboard-engine-mark--${engine}" aria-hidden="true">
      ${engine === "codex" ? "OpenAI" : "Claude"}
    </span>
  `;
}

export function renderStartExecutionButton(
  props: WorkboardProps,
  card: WorkboardCard,
  engine: WorkboardExecutionEngine | null,
  mode: WorkboardExecutionMode,
  options: { iconOnly?: boolean } = {},
) {
  const state = getWorkboardState(props.host);
  const busy = state.busyCardIds.has(card.id) || state.dispatching;
  const runtimeBlock = engineBlockedByRuntime(props, card, engine);
  const engineName = engine === "codex" ? t("workboard.engineOpenAI") : t("workboard.engineClaude");
  const disabled =
    busy || !props.connected || Boolean(runtimeBlock) || Boolean(card.metadata?.archivedAt);
  const title = runtimeBlock
    ? runtimeBlock
    : engine
      ? mode === "autonomous"
        ? t("workboard.runEngine", { engine: engineName })
        : t("workboard.openEngine", { engine: engineName })
      : t("workboard.runDefaultAgent");
  const button = html`
    <button
      class="btn btn--xs workboard-card__start workboard-card__start--${mode} ${options.iconOnly
        ? "workboard-card__start--icon"
        : ""} ${engine ? "" : "workboard-card__start--default"}"
      type="button"
      aria-label=${title}
      ?disabled=${disabled}
      @click=${async () => {
        const key = await startWorkboardCard({
          host: props.host,
          client: props.client,
          card,
          ...(engine ? { engine } : {}),
          mode,
          requestUpdate: props.onRequestUpdate,
        });
        if (key) {
          props.onOpenSession(key);
        }
      }}
    >
      ${engine
        ? html`${renderEngineMark(engine)}${options.iconOnly
            ? nothing
            : html`<span
                >${mode === "autonomous" ? t("workboard.run") : t("workboard.open")}</span
              >`}`
        : html`${mode === "autonomous" ? icons.play : icons.penLine}${options.iconOnly
            ? nothing
            : html`<span>${t("workboard.start")}</span>`}`}
    </button>
  `;
  return options.iconOnly
    ? html`<openclaw-tooltip .content=${title}>${button}</openclaw-tooltip>`
    : button;
}

export function renderStartExecutionControls(props: WorkboardProps, card: WorkboardCard) {
  const canModelOverride = props.canModelOverride !== false;
  return html`
    <div class="workboard-card__execution-controls">
      ${renderStartExecutionButton(props, card, null, "autonomous")}
      ${canModelOverride
        ? html`${renderStartExecutionButton(props, card, "codex", "autonomous")}
          ${renderStartExecutionButton(props, card, "claude", "autonomous")}`
        : nothing}
      ${renderStartExecutionButton(props, card, "codex", "manual")}
      ${renderStartExecutionButton(props, card, "claude", "manual")}
    </div>
  `;
}
