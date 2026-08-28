import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { workboardCardSessionKey } from "../../lib/workboard/card-state.ts";
import {
  addWorkboardCardComment,
  getWorkboardState,
  resetDraftState,
  saveWorkboardCardDraft,
  WORKBOARD_PRIORITIES,
  type WorkboardCard,
  type WorkboardPriority,
  type WorkboardStatus,
  type WorkboardTemplateId,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import { buildAssignableAgentOptions } from "./agent-filter.ts";
import {
  canMutate,
  formatPriorityLabel,
  formatStatusLabel,
  isWorkboardSessionChoice,
  type WorkboardProps,
} from "./view-helpers.ts";
import { renderWorkboardSelect, type WorkboardSelectOption } from "./workboard-select.ts";

const workboardCardModalTitleId = "workboard-card-modal-title";
const workboardCardModalDescriptionId = "workboard-card-modal-description";
export const workboardCardModalId = "workboard-card-modal";

// Keep keystroke state local to the form. A parent render can restore stale
// controlled values before the next field is edited or the draft is submitted.
function syncDraftTextInput(
  state: WorkboardUiState,
  form: HTMLFormElement,
  input: HTMLInputElement | HTMLTextAreaElement,
  draftActionsBusy: boolean,
) {
  if (input.classList.contains("workboard-draft__title")) {
    state.draftTitle = input.value;
  } else if (input.classList.contains("workboard-draft__notes")) {
    state.draftNotes = input.value;
  } else if (input.classList.contains("workboard-draft__labels")) {
    state.draftLabels = input.value;
  } else if (input.classList.contains("workboard-comments__input")) {
    state.draftCommentBody = input.value;
  } else {
    return;
  }

  const draftSubmit = form.querySelector<HTMLButtonElement>(".workboard-draft__submit");
  if (draftSubmit) {
    draftSubmit.disabled = draftActionsBusy || !state.draftTitle.trim();
  }
  const commentSubmit = form.querySelector<HTMLButtonElement>(".workboard-comments__submit");
  if (commentSubmit) {
    commentSubmit.disabled = draftActionsBusy || !state.draftCommentBody.trim();
  }
}

function defineTemplate(
  id: WorkboardTemplateId,
  draftKey: string,
  labels: string,
  priority: WorkboardPriority,
) {
  return { id, draftKey, labels, priority };
}

const workboardTemplates = [
  defineTemplate("bugfix", "bugfix", "fix, test", "high"),
  defineTemplate("docs", "docs", "docs", "normal"),
  defineTemplate("release", "release", "release", "urgent"),
  defineTemplate("pr_review", "prReview", "review", "normal"),
  defineTemplate("plugin", "plugin", "plugin", "normal"),
];

export function openCreateModal(
  state: WorkboardUiState,
  props: Pick<WorkboardProps, "agentsList" | "defaultAgentId" | "scopeAgentId">,
) {
  resetDraftState(state);
  const scopedAgentId = props.scopeAgentId?.trim();
  const defaultAgentId = props.agentsList?.defaultId?.trim() ?? props.defaultAgentId?.trim();
  const selectedAgentId = scopedAgentId
    ? scopedAgentId === defaultAgentId
      ? ""
      : scopedAgentId
    : state.agentFilter === "all" || state.agentFilter === "default"
      ? ""
      : state.agentFilter;
  if (
    selectedAgentId &&
    (props.agentsList
      ? buildAssignableAgentOptions(props.agentsList, "").some(
          (agent) => agent.id === selectedAgentId,
        )
      : Boolean(scopedAgentId))
  ) {
    state.draftAgentId = selectedAgentId;
  }
  state.draftOpen = true;
}

export function openEditModal(state: WorkboardUiState, card: WorkboardCard) {
  state.draftOpen = true;
  state.editingCardId = card.id;
  state.editingCardBase = card;
  state.draftTitle = card.title;
  state.draftNotes = card.notes ?? "";
  state.draftStatus = card.status;
  state.draftPriority = card.priority;
  state.draftLabels = card.labels.join(", ");
  state.draftAgentId = card.agentId ?? "";
  state.draftSessionKey = workboardCardSessionKey(card) ?? "";
  state.draftTemplateId = card.metadata?.templateId ?? "";
  state.draftCommentBody = "";
}

function applyTemplate(state: WorkboardUiState, templateId: WorkboardTemplateId) {
  const template = workboardTemplates.find((entry) => entry.id === templateId);
  if (!template) {
    return;
  }
  state.draftTemplateId = template.id;
  state.draftTitle = t(`workboard.templateDraft.${template.draftKey}Title`);
  state.draftNotes = t(`workboard.templateDraft.${template.draftKey}Notes`);
  state.draftLabels = template.labels;
  state.draftPriority = template.priority;
}

export function renderCardModal(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const agentOptions = buildAssignableAgentOptions(props.agentsList, state.draftAgentId);
  const sessions = props.sessions.filter(isWorkboardSessionChoice);
  const statusOptions: WorkboardSelectOption<WorkboardStatus>[] = state.statuses.map((status) => ({
    value: status,
    label: formatStatusLabel(status),
  }));
  const priorityOptions: WorkboardSelectOption<WorkboardPriority>[] = WORKBOARD_PRIORITIES.map(
    (priority) => ({ value: priority, label: formatPriorityLabel(priority) }),
  );
  const assignableAgentOptions = agentOptions.map((option) => ({
    value: option.id,
    label: option.label,
    agent: option.id
      ? (props.agentsList?.agents.find((agent) => agent.id === option.id) ?? { id: option.id })
      : undefined,
    icon: option.id ? undefined : icons.bot,
  }));
  const sessionOptions: WorkboardSelectOption[] = [
    { value: "", label: t("workboard.noLinkedSession") },
    ...sessions.map((session) => ({
      value: session.key,
      label: session.displayName ?? session.label ?? session.key,
    })),
  ];
  if (
    state.draftSessionKey &&
    !sessionOptions.some((option) => option.value === state.draftSessionKey)
  ) {
    sessionOptions.push({ value: state.draftSessionKey, label: state.draftSessionKey });
  }
  if (!state.draftOpen) {
    return nothing;
  }
  const editing = Boolean(state.editingCardId);
  const editingCard = state.editingCardId
    ? (state.cards.find((card) => card.id === state.editingCardId) ?? null)
    : null;
  const comments = editingCard?.metadata?.comments ?? [];
  const draftCommentBusy = editing && state.busyCardIds.has(state.editingCardId ?? "");
  const draftActionsBusy =
    !canMutate(props) || state.loading || state.dispatching || draftCommentBusy;
  // Save completion resets this shared draft. Lock every edit and dismissal path
  // only for that write so stale drafts can still use Cancel to recover readiness.
  const draftDismissalBusy = state.draftSaving;
  const dismissDraft = () => {
    if (draftDismissalBusy) {
      return false;
    }
    resetDraftState(state);
    return true;
  };
  return html`
    <openclaw-modal-dialog
      label=${editing ? t("workboard.editCard") : t("workboard.newCard")}
      description=${editing ? t("workboard.editCardHelp") : t("workboard.newCardHelp")}
      style="--openclaw-modal-width: min(1120px, calc(100vw - 56px)); --openclaw-modal-max-height: calc(100dvh - 56px);"
      @modal-cancel=${(event: Event) => {
        if (!dismissDraft()) {
          event.preventDefault();
          return;
        }
        props.onRequestUpdate?.();
      }}
    >
      <form
        id=${workboardCardModalId}
        class="workboard-draft"
        aria-busy=${draftActionsBusy ? "true" : "false"}
        @input=${(event: InputEvent) => {
          const input = event.target;
          if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
            syncDraftTextInput(
              state,
              event.currentTarget as HTMLFormElement,
              input,
              draftActionsBusy,
            );
          }
        }}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          if (draftActionsBusy) {
            return;
          }
          void saveWorkboardCardDraft({
            host: props.host,
            client: props.client,
            requestUpdate: props.onRequestUpdate,
          });
        }}
      >
        <div class="workboard-modal__header">
          <div>
            <h2 id=${workboardCardModalTitleId}>
              ${editing ? t("workboard.editCard") : t("workboard.newCard")}
            </h2>
            <p id=${workboardCardModalDescriptionId}>
              ${editing ? t("workboard.editCardHelp") : t("workboard.newCardHelp")}
            </p>
          </div>
          <openclaw-tooltip .content=${t("common.cancel")}>
            <button
              class="btn btn--icon workboard-card__icon"
              type="button"
              aria-label=${t("common.cancel")}
              ?disabled=${draftDismissalBusy}
              @click=${() => {
                if (dismissDraft()) {
                  props.onRequestUpdate?.();
                }
              }}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        </div>
        <div class="workboard-draft__body">
          ${!editing
            ? html`
                <div class="workboard-template-strip" aria-label=${t("workboard.templatesLabel")}>
                  ${workboardTemplates.map(
                    (template) => html`
                      <button
                        class="btn btn--xs ${state.draftTemplateId === template.id
                          ? "workboard-template-strip__button--active"
                          : ""}"
                        type="button"
                        ?disabled=${draftActionsBusy}
                        @click=${() => {
                          applyTemplate(state, template.id);
                          props.onRequestUpdate?.();
                        }}
                      >
                        ${t(`workboard.template.${template.id}`)}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing}
          <div class="workboard-draft__main">
            <label class="workboard-field">
              <span>${t("workboard.fieldTitle")}</span>
              <input
                class="input workboard-draft__title"
                autofocus
                placeholder=${t("workboard.titlePlaceholder")}
                ?disabled=${draftActionsBusy}
                .value=${state.draftTitle}
              />
            </label>
            <label class="workboard-field">
              <span>${t("workboard.fieldNotes")}</span>
              <textarea
                class="input workboard-draft__notes"
                placeholder=${t("workboard.notesPlaceholder")}
                ?disabled=${draftActionsBusy}
                .value=${state.draftNotes}
              ></textarea>
            </label>
          </div>
          <div class="workboard-draft__meta">
            ${renderWorkboardSelect({
              value: state.draftStatus,
              options: statusOptions,
              label: t("workboard.fieldStatus"),
              onChange: (value) => {
                state.draftStatus = value;
              },
              requestUpdate: props.onRequestUpdate,
              disabled: draftActionsBusy,
            })}
            ${renderWorkboardSelect({
              value: state.draftPriority,
              options: priorityOptions,
              label: t("workboard.fieldPriority"),
              onChange: (value) => {
                state.draftPriority = value;
              },
              requestUpdate: props.onRequestUpdate,
              disabled: draftActionsBusy,
            })}
            <div class="workboard-field">
              <span>${t("workboard.fieldAgent")}</span>
              <openclaw-agent-select
                class="workboard-agent-select"
                .options=${assignableAgentOptions}
                .value=${state.draftAgentId}
                .accessibleLabel=${t("workboard.fieldAgent")}
                .disabled=${draftActionsBusy}
                .onSelect=${(value: string) => {
                  state.draftAgentId = value;
                  props.onRequestUpdate?.();
                }}
              ></openclaw-agent-select>
            </div>
            ${renderWorkboardSelect({
              value: state.draftSessionKey,
              options: sessionOptions,
              label: t("workboard.fieldSession"),
              onChange: (value) => {
                state.draftSessionKey = value;
              },
              requestUpdate: props.onRequestUpdate,
              disabled: draftActionsBusy,
            })}
            <label class="workboard-field workboard-field--wide">
              <span>${t("workboard.fieldLabels")}</span>
              <input
                class="input workboard-draft__labels"
                placeholder=${t("workboard.labelsPlaceholder")}
                ?disabled=${draftActionsBusy}
                .value=${state.draftLabels}
              />
            </label>
          </div>
          ${editing
            ? html`
                <section
                  class="workboard-field workboard-field--wide"
                  aria-labelledby="workboard-card-comments-title"
                >
                  <span id="workboard-card-comments-title">
                    ${t("workboard.badgeComments", { count: String(comments.length) })}
                  </span>
                  ${comments.length
                    ? html`
                        <ol>
                          ${comments.map((comment) => html`<li>${comment.body}</li>`)}
                        </ol>
                      `
                    : nothing}
                  <textarea
                    class="input workboard-comments__input"
                    aria-labelledby="workboard-card-comments-title"
                    maxlength="2000"
                    ?disabled=${draftActionsBusy}
                    .value=${state.draftCommentBody}
                  ></textarea>
                  <div class="workboard-modal__actions">
                    <button
                      class="btn workboard-comments__submit"
                      type="button"
                      ?disabled=${draftActionsBusy || !state.draftCommentBody.trim()}
                      @click=${() => {
                        void addWorkboardCardComment({
                          host: props.host,
                          client: props.client,
                          requestUpdate: props.onRequestUpdate,
                        });
                      }}
                    >
                      ${icons.plus} ${t("common.create")}
                    </button>
                  </div>
                </section>
              `
            : nothing}
        </div>
        <div class="workboard-modal__actions">
          <button
            class="btn primary workboard-draft__submit"
            ?disabled=${draftActionsBusy || !state.draftTitle.trim()}
          >
            ${editing ? t("common.save") : t("common.create")}
          </button>
          <button
            class="btn"
            type="button"
            ?disabled=${draftDismissalBusy}
            @click=${() => {
              if (dismissDraft()) {
                props.onRequestUpdate?.();
              }
            }}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>
  `;
}
