import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import {
  addWorkboardCardComment,
  archiveWorkboardCard,
  deleteWorkboardCard,
  dispatchWorkboard,
  findWorkboardSession,
  getWorkboardLifecycle,
  getWorkboardState,
  loadWorkboard,
  moveWorkboardCard,
  saveWorkboardCardDraft,
  startWorkboardCard,
  stopWorkboardCard,
  syncWorkboardLifecycle,
  WORKBOARD_PRIORITIES,
  type WorkboardExecutionEngine,
  type WorkboardExecutionMode,
  type WorkboardCard,
  type WorkboardEvent,
  type WorkboardLifecycle,
  type WorkboardPriority,
  type WorkboardStatus,
  type WorkboardTaskSummary,
  type WorkboardTemplateId,
  type WorkboardUiState,
} from "../controllers/workboard.ts";
import { formatDateMs } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { icons } from "../icons.ts";
import type { AgentsListResult, GatewaySessionRow } from "../types.ts";

type WorkboardProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  canWrite?: boolean;
  canModelOverride?: boolean;
  pluginEnabled: boolean;
  agentsList: AgentsListResult | null;
  sessions: GatewaySessionRow[];
  onOpenSession: (sessionKey: string) => void;
  onRequestUpdate?: () => void;
};

const WORKBOARD_TEMPLATES: Array<{
  id: WorkboardTemplateId;
  title: string;
  notes: string;
  labels: string;
  priority: WorkboardPriority;
}> = [
  {
    id: "bugfix",
    title: "Fix: ",
    notes: "Symptom:\nCause:\nAcceptance:\nProof:",
    labels: "fix, test",
    priority: "high",
  },
  {
    id: "docs",
    title: "Docs: ",
    notes: "Page:\nChange:\nSource proof:",
    labels: "docs",
    priority: "normal",
  },
  {
    id: "release",
    title: "Release: ",
    notes: "Scope:\nVerification:\nCloseout:",
    labels: "release",
    priority: "urgent",
  },
  {
    id: "pr_review",
    title: "Review PR ",
    notes: "Surface:\nRisks:\nProof:",
    labels: "review",
    priority: "normal",
  },
  {
    id: "plugin",
    title: "Plugin: ",
    notes: "Boundary:\nConfig/docs:\nTests:",
    labels: "plugin",
    priority: "normal",
  },
];

function formatStatusLabel(status: WorkboardStatus): string {
  return t(`workboard.status.${status}`);
}

function formatTime(value: number | undefined): string {
  if (!value) {
    return "";
  }
  return formatDateMs(
    value,
    {
      month: "short",
      day: "numeric",
    },
    "",
  );
}

function canMutate(props: WorkboardProps): boolean {
  return props.canWrite !== false;
}

function formatEventLabel(event: WorkboardEvent): string {
  switch (event.kind) {
    case "created":
      return t("workboard.eventCreated");
    case "edited":
      return t("workboard.eventEdited");
    case "moved":
      return event.toStatus
        ? t("workboard.eventMovedTo", { status: formatStatusLabel(event.toStatus) })
        : t("workboard.eventMoved");
    case "linked":
      return t("workboard.eventLinked");
    case "specified":
      return t("workboard.eventSpecified");
    case "decomposed":
      return t("workboard.eventDecomposed");
    case "claimed":
      return t("workboard.eventClaimed");
    case "heartbeat":
      return t("workboard.eventHeartbeat");
    case "execution_updated":
      return t("workboard.eventExecutionUpdated");
    case "attempt_started":
      return t("workboard.eventAttemptStarted");
    case "attempt_updated":
      return t("workboard.eventAttemptUpdated");
    case "comment_added":
      return t("workboard.eventCommentAdded");
    case "link_added":
      return t("workboard.eventLinkAdded");
    case "proof_added":
      return t("workboard.eventProofAdded");
    case "artifact_added":
      return t("workboard.eventArtifactAdded");
    case "attachment_added":
      return t("workboard.eventAttachmentAdded");
    case "diagnostic":
      return t("workboard.eventDiagnostic");
    case "notification":
      return t("workboard.eventNotification");
    case "dispatch":
      return t("workboard.eventDispatch");
    case "orchestration":
      return t("workboard.eventOrchestration");
    case "protocol_violation":
      return t("workboard.eventProtocolViolation");
    case "archived":
      return t("workboard.eventArchived");
    case "unarchived":
      return t("workboard.eventUnarchived");
    case "stale":
      return t("workboard.eventStale");
  }
  return "";
}

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
            <time>${formatTime(event.at)}</time>
          </li>
        `,
      )}
    </ol>
  `;
}

function renderCompactBadges(card: WorkboardCard, task?: WorkboardTaskSummary) {
  const metadata = card.metadata;
  const badges = [
    metadata?.templateId ? t(`workboard.template.${metadata.templateId}`) : null,
    (task ?? card.taskId) ? t("workboard.badgeTaskLinked") : null,
    metadata?.failureCount
      ? t("workboard.badgeFailures", { count: String(metadata.failureCount) })
      : null,
    metadata?.comments?.length
      ? t("workboard.badgeComments", { count: String(metadata.comments.length) })
      : null,
    metadata?.proof?.length
      ? t("workboard.badgeProof", { count: String(metadata.proof.length) })
      : null,
    metadata?.claim ? t("workboard.badgeClaimed", { owner: metadata.claim.ownerId }) : null,
    metadata?.diagnostics?.length
      ? t("workboard.badgeDiagnostics", { count: String(metadata.diagnostics.length) })
      : null,
    metadata?.stale ? t("workboard.badgeStale") : null,
  ].filter((badge): badge is string => Boolean(badge));
  if (badges.length === 0) {
    return nothing;
  }
  return html`
    <div class="workboard-card__badges">${badges.map((badge) => html`<span>${badge}</span>`)}</div>
  `;
}

function matchesFilter(
  card: WorkboardCard,
  options: { query: string; priority: "all" | WorkboardPriority },
): boolean {
  if (options.priority !== "all" && card.priority !== options.priority) {
    return false;
  }
  const query = options.query.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return [
    card.title,
    card.notes,
    card.agentId,
    card.sessionKey,
    card.execution?.engine,
    card.execution?.mode,
    card.execution?.model,
    card.execution?.sessionKey,
    card.metadata?.templateId,
    card.metadata?.automation?.tenant,
    card.metadata?.automation?.idempotencyKey,
    card.metadata?.automation?.workspace?.kind,
    card.metadata?.automation?.workspace?.path,
    card.metadata?.automation?.workspace?.branch,
    ...(card.metadata?.automation?.skills ?? []),
    ...(card.metadata?.automation?.createdCardIds ?? []),
    ...(card.metadata?.comments ?? []).map((comment) => comment.body),
    ...(card.metadata?.links ?? []).flatMap((link) => [link.title, link.url, link.targetCardId]),
    ...(card.metadata?.proof ?? []).flatMap((proof) => [
      proof.label,
      proof.command,
      proof.url,
      proof.note,
    ]),
    ...(card.metadata?.artifacts ?? []).flatMap((artifact) => [
      artifact.label,
      artifact.url,
      artifact.path,
      artifact.mimeType,
    ]),
    ...(card.metadata?.attachments ?? []).flatMap((attachment) => [
      attachment.fileName,
      attachment.mimeType,
      attachment.note,
    ]),
    ...(card.metadata?.workerLogs ?? []).map((log) => log.message),
    card.metadata?.workerProtocol?.state,
    card.metadata?.workerProtocol?.detail,
    card.metadata?.claim?.ownerId,
    ...(card.metadata?.diagnostics ?? []).flatMap((diagnostic) => [
      diagnostic.kind,
      diagnostic.severity,
      diagnostic.title,
      diagnostic.detail,
    ]),
    ...(card.metadata?.notifications ?? []).map((notification) => notification.message),
    ...card.labels,
  ]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(query));
}

function nextPosition(cards: readonly WorkboardCard[], status: WorkboardStatus): number {
  const positions = cards.filter((card) => card.status === status).map((card) => card.position);
  return (positions.length ? Math.max(...positions) : 0) + 1000;
}

function isWorkboardSessionChoice(session: GatewaySessionRow): boolean {
  if (session.archived || session.kind === "global") {
    return false;
  }
  const raw = [session.key, session.label, session.displayName]
    .filter((value): value is string => typeof value === "string")
    .join(":")
    .toLowerCase();
  return !/(^|:)heartbeat(:|$)/.test(raw);
}

function isCardActionTarget(event: Event): boolean {
  return event.target instanceof Element
    ? Boolean(event.target.closest("button, a, input, select, textarea"))
    : false;
}

function openCardDetails(state: WorkboardUiState, card: WorkboardCard) {
  state.detailCardId = card.id;
  state.detailCommentBody = "";
}

function resetDraft(state: WorkboardUiState) {
  state.draftOpen = false;
  state.editingCardId = null;
  state.draftTitle = "";
  state.draftNotes = "";
  state.draftStatus = "todo";
  state.draftPriority = "normal";
  state.draftLabels = "";
  state.draftAgentId = "";
  state.draftSessionKey = "";
  state.draftTemplateId = "";
  state.draftCommentBody = "";
}

function openCreateModal(state: WorkboardUiState) {
  resetDraft(state);
  state.draftOpen = true;
}

function openEditModal(state: WorkboardUiState, card: WorkboardCard) {
  state.draftOpen = true;
  state.editingCardId = card.id;
  state.draftTitle = card.title;
  state.draftNotes = card.notes ?? "";
  state.draftStatus = card.status;
  state.draftPriority = card.priority;
  state.draftLabels = card.labels.join(", ");
  state.draftAgentId = card.agentId ?? "";
  state.draftSessionKey = card.sessionKey ?? "";
  state.draftTemplateId = card.metadata?.templateId ?? "";
  state.draftCommentBody = "";
}

function applyTemplate(state: WorkboardUiState, templateId: WorkboardTemplateId) {
  const template = WORKBOARD_TEMPLATES.find((entry) => entry.id === templateId);
  if (!template) {
    return;
  }
  state.draftTemplateId = template.id;
  state.draftTitle = template.title;
  state.draftNotes = template.notes;
  state.draftLabels = template.labels;
  state.draftPriority = template.priority;
}

function renderCardModal(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const agents = props.agentsList?.agents ?? [];
  const sessions = props.sessions.filter(isWorkboardSessionChoice);
  if (!state.draftOpen) {
    return nothing;
  }
  const editing = Boolean(state.editingCardId);
  const editingCard = state.editingCardId
    ? (state.cards.find((card) => card.id === state.editingCardId) ?? null)
    : null;
  const comments = editingCard?.metadata?.comments ?? [];
  const draftCommentBusy = editing && state.busyCardId === state.editingCardId;
  return html`
    <div
      class="workboard-modal"
      role="presentation"
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) {
          resetDraft(state);
          props.onRequestUpdate?.();
        }
      }}
    >
      <form
        class="workboard-draft"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workboard-card-modal-title"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          if (state.loading || draftCommentBusy) {
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
            <h2 id="workboard-card-modal-title">
              ${editing ? t("workboard.editCard") : t("workboard.newCard")}
            </h2>
            <p>${editing ? t("workboard.editCardHelp") : t("workboard.newCardHelp")}</p>
          </div>
          <button
            class="btn btn--icon workboard-card__icon"
            type="button"
            title=${t("common.cancel")}
            @click=${() => {
              resetDraft(state);
              props.onRequestUpdate?.();
            }}
          >
            ${icons.x}
          </button>
        </div>
        ${!editing
          ? html`
              <div class="workboard-template-strip" aria-label=${t("workboard.templatesLabel")}>
                ${WORKBOARD_TEMPLATES.map(
                  (template) => html`
                    <button
                      class="btn btn--xs ${state.draftTemplateId === template.id
                        ? "workboard-template-strip__button--active"
                        : ""}"
                      type="button"
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
              placeholder=${t("workboard.titlePlaceholder")}
              .value=${state.draftTitle}
              @input=${(event: InputEvent) => {
                state.draftTitle = (event.currentTarget as HTMLInputElement).value;
                props.onRequestUpdate?.();
              }}
            />
          </label>
          <label class="workboard-field">
            <span>${t("workboard.fieldNotes")}</span>
            <textarea
              class="input workboard-draft__notes"
              placeholder=${t("workboard.notesPlaceholder")}
              .value=${state.draftNotes}
              @input=${(event: InputEvent) => {
                state.draftNotes = (event.currentTarget as HTMLTextAreaElement).value;
                props.onRequestUpdate?.();
              }}
            ></textarea>
          </label>
        </div>
        <div class="workboard-draft__meta">
          <label class="workboard-field">
            <span>${t("workboard.fieldStatus")}</span>
            <select
              class="input"
              .value=${state.draftStatus}
              @change=${(event: Event) => {
                state.draftStatus = (event.currentTarget as HTMLSelectElement)
                  .value as WorkboardStatus;
                props.onRequestUpdate?.();
              }}
            >
              ${state.statuses.map(
                (status) => html`<option value=${status}>${formatStatusLabel(status)}</option>`,
              )}
            </select>
          </label>
          <label class="workboard-field">
            <span>${t("workboard.fieldPriority")}</span>
            <select
              class="input"
              .value=${state.draftPriority}
              @change=${(event: Event) => {
                state.draftPriority = (event.currentTarget as HTMLSelectElement)
                  .value as WorkboardPriority;
                props.onRequestUpdate?.();
              }}
            >
              ${WORKBOARD_PRIORITIES.map(
                (priority) => html`<option value=${priority}>${priority}</option>`,
              )}
            </select>
          </label>
          <label class="workboard-field">
            <span>${t("workboard.fieldAgent")}</span>
            <select
              class="input"
              .value=${state.draftAgentId}
              @change=${(event: Event) => {
                state.draftAgentId = (event.currentTarget as HTMLSelectElement).value;
                props.onRequestUpdate?.();
              }}
            >
              <option value="">${t("workboard.defaultAgent")}</option>
              ${agents.map(
                (agent) =>
                  html`<option value=${agent.id}>
                    ${agent.name ?? agent.identity?.name ?? agent.id}
                  </option>`,
              )}
            </select>
          </label>
          <label class="workboard-field">
            <span>${t("workboard.fieldSession")}</span>
            <select
              class="input"
              .value=${state.draftSessionKey}
              @change=${(event: Event) => {
                state.draftSessionKey = (event.currentTarget as HTMLSelectElement).value;
                props.onRequestUpdate?.();
              }}
            >
              <option value="">${t("workboard.noLinkedSession")}</option>
              ${sessions.map(
                (session) =>
                  html`<option value=${session.key}>
                    ${session.displayName ?? session.label ?? session.key}
                  </option>`,
              )}
            </select>
          </label>
          <label class="workboard-field workboard-field--wide">
            <span>${t("workboard.fieldLabels")}</span>
            <input
              class="input"
              placeholder=${t("workboard.labelsPlaceholder")}
              .value=${state.draftLabels}
              @input=${(event: InputEvent) => {
                state.draftLabels = (event.currentTarget as HTMLInputElement).value;
                props.onRequestUpdate?.();
              }}
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
                  .value=${state.draftCommentBody}
                  @input=${(event: InputEvent) => {
                    state.draftCommentBody = (event.currentTarget as HTMLTextAreaElement).value;
                    props.onRequestUpdate?.();
                  }}
                ></textarea>
                <div class="workboard-modal__actions">
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${state.loading || draftCommentBusy || !state.draftCommentBody.trim()}
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
        <div class="workboard-modal__actions">
          <button
            class="btn primary"
            ?disabled=${state.loading || draftCommentBusy || !state.draftTitle.trim()}
          >
            ${editing ? t("common.save") : t("common.create")}
          </button>
          <button
            class="btn"
            type="button"
            @click=${() => {
              resetDraft(state);
              props.onRequestUpdate?.();
            }}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </div>
  `;
}

function formatLifecycle(lifecycle: WorkboardLifecycle): {
  label: string;
  detail: string;
  tone: "blocked" | "done" | "idle" | "live";
} {
  switch (lifecycle.state) {
    case "running":
      return {
        label: t("workboard.lifecycleRunning"),
        detail: t("workboard.lifecycleRunningDetail"),
        tone: "live",
      };
    case "succeeded":
      return {
        label: t("workboard.lifecycleDone"),
        detail: t("workboard.lifecycleDoneDetail"),
        tone: "done",
      };
    case "failed":
      return {
        label: t("workboard.lifecycleNeedsReview"),
        detail: t("workboard.lifecycleNeedsReviewDetail"),
        tone: "blocked",
      };
    case "stale":
      return {
        label: t("workboard.lifecycleStale"),
        detail: t("workboard.lifecycleStaleDetail"),
        tone: "blocked",
      };
    case "idle":
      return {
        label: t("workboard.lifecycleLinked"),
        detail: t("workboard.lifecycleIdleDetail"),
        tone: "idle",
      };
    case "missing":
      return {
        label: t("workboard.lifecycleMissing"),
        detail: t("workboard.lifecycleMissingDetail"),
        tone: "blocked",
      };
    case "unlinked":
      return {
        label: t("workboard.lifecycleUnlinked"),
        detail: t("workboard.lifecycleUnlinkedDetail"),
        tone: "idle",
      };
  }
  throw new Error("Unknown workboard lifecycle state.");
}

function taskDetail(task: WorkboardTaskSummary): string {
  if (task.status === "queued" || task.status === "running") {
    return task.progressSummary ?? task.title ?? task.taskId;
  }
  return task.terminalSummary ?? task.error ?? task.progressSummary ?? task.title ?? task.taskId;
}

function taskMatchesLifecycle(task: WorkboardTaskSummary, lifecycle: WorkboardLifecycle): boolean {
  switch (task.status) {
    case "queued":
    case "running":
      return lifecycle.state === "running";
    case "completed":
      return lifecycle.state === "succeeded";
    case "failed":
    case "cancelled":
    case "timed_out":
      return lifecycle.state === "failed";
  }
  return false;
}

function taskIsActive(task: WorkboardTaskSummary | undefined): boolean {
  return task?.status === "queued" || task?.status === "running";
}

function cardCanStart(
  state: WorkboardUiState,
  sessions: readonly GatewaySessionRow[],
  card: WorkboardCard,
): boolean {
  const task = state.tasksByCardId.get(card.id);
  const session = findWorkboardSession(card, sessions);
  const activeTask = taskIsActive(task);
  const linkedSessionKey = card.sessionKey ?? card.execution?.sessionKey;
  return !activeTask && (!linkedSessionKey || !session);
}

function renderLifecycle(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
  task?: WorkboardTaskSummary,
) {
  const lifecycle = getWorkboardLifecycle(card, sessions, task);
  const formatted = formatLifecycle(lifecycle);
  const session = lifecycle.session;
  const execution = card.execution;
  const stale = lifecycle.state === "stale";
  const taskIsAuthoritative = task ? taskMatchesLifecycle(task, lifecycle) : false;
  const taskStatus = task && taskIsAuthoritative ? t(`workboard.taskStatus.${task.status}`) : null;
  return html`
    <div class="workboard-card__lifecycle">
      <span class="workboard-lifecycle workboard-lifecycle--${formatted.tone}">
        ${taskStatus ??
        (stale || !execution ? formatted.label : `${execution.engine} ${execution.mode}`)}
      </span>
      <span class="workboard-card__lifecycle-detail">
        ${task && taskIsAuthoritative
          ? taskDetail(task)
          : stale
            ? formatted.detail
            : (session?.displayName ?? session?.label ?? formatted.detail)}
      </span>
    </div>
  `;
}

function renderStartExecutionButton(
  props: WorkboardProps,
  card: WorkboardCard,
  engine: WorkboardExecutionEngine | null,
  mode: WorkboardExecutionMode,
) {
  const state = getWorkboardState(props.host);
  const busy = state.busyCardId === card.id;
  const title = engine
    ? mode === "autonomous"
      ? t("workboard.runEngine", { engine })
      : t("workboard.openEngine", { engine })
    : t("workboard.runDefaultAgent");
  return html`
    <button
      class="btn btn--xs workboard-card__start workboard-card__start--${mode} ${engine
        ? ""
        : "workboard-card__start--default"}"
      title=${title}
      ?disabled=${busy || !props.connected}
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
      ${mode === "autonomous" ? icons.play : icons.penLine} ${engine ?? t("workboard.start")}
    </button>
  `;
}

function renderStartExecutionControls(props: WorkboardProps, card: WorkboardCard) {
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

function renderDetailRow(label: string, value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return nothing;
  }
  const text = String(value).trim();
  if (!text) {
    return nothing;
  }
  return html`
    <div class="workboard-detail__row">
      <span>${label}</span>
      <strong>${text}</strong>
    </div>
  `;
}

function renderDetailList(
  title: string,
  values: readonly string[],
  empty: string | typeof nothing = nothing,
) {
  const entries = values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(-6);
  if (entries.length === 0) {
    return empty;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${title}</h3>
      <ol class="workboard-detail__list">
        ${entries.map((entry) => html`<li>${entry}</li>`)}
      </ol>
    </section>
  `;
}

function renderCardDetailsPanel(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const card = state.detailCardId
    ? (state.cards.find((entry) => entry.id === state.detailCardId) ?? null)
    : null;
  if (!card || card.metadata?.archivedAt) {
    return nothing;
  }
  const task = state.tasksByCardId.get(card.id);
  const lifecycle = getWorkboardLifecycle(card, props.sessions, task);
  const formatted = formatLifecycle(lifecycle);
  const taskIsAuthoritative = task ? taskMatchesLifecycle(task, lifecycle) : false;
  const linkedSessionKey = card.sessionKey ?? card.execution?.sessionKey;
  const writable = canMutate(props);
  const comments = card.metadata?.comments ?? [];
  const attempts = card.metadata?.attempts ?? [];
  const links = card.metadata?.links ?? [];
  const proof = card.metadata?.proof ?? [];
  const artifacts = card.metadata?.artifacts ?? [];
  const attachments = card.metadata?.attachments ?? [];
  const diagnostics = card.metadata?.diagnostics ?? [];
  const workerLogs = card.metadata?.workerLogs ?? [];
  const workerProtocol = card.metadata?.workerProtocol;
  const automation = card.metadata?.automation;
  const events = (card.events ?? []).slice(-6).toReversed();
  const busy = state.busyCardId === card.id;
  const showStartControls = writable && cardCanStart(state, props.sessions, card);
  return html`
    <aside class="workboard-detail-drawer" aria-label=${t("workboard.detailTitle")}>
      <div class="workboard-detail">
        <header class="workboard-detail__header">
          <div>
            <span class="workboard-card__priority">${card.priority}</span>
            <h2>${card.title}</h2>
          </div>
          <button
            class="btn btn--icon workboard-card__icon"
            type="button"
            title=${t("common.cancel")}
            @click=${() => {
              state.detailCardId = null;
              state.detailCommentBody = "";
              props.onRequestUpdate?.();
            }}
          >
            ${icons.x}
          </button>
        </header>

        <section class="workboard-detail__section">
          <div class="workboard-card__lifecycle">
            <span class="workboard-lifecycle workboard-lifecycle--${formatted.tone}">
              ${formatted.label}
            </span>
            <span class="workboard-card__lifecycle-detail">
              ${task && taskIsAuthoritative
                ? taskDetail(task)
                : (lifecycle.session?.displayName ?? formatted.detail)}
            </span>
          </div>
          <div class="workboard-detail__grid">
            ${renderDetailRow(t("workboard.fieldStatus"), formatStatusLabel(card.status))}
            ${renderDetailRow(
              t("workboard.fieldAgent"),
              card.agentId ?? t("workboard.defaultAgent"),
            )}
            ${renderDetailRow(t("workboard.detailTask"), task?.taskId ?? card.taskId)}
            ${renderDetailRow(t("workboard.fieldSession"), linkedSessionKey)}
            ${renderDetailRow(t("workboard.detailRun"), card.runId ?? card.execution?.runId)}
            ${renderDetailRow(t("workboard.detailUpdated"), formatTime(card.updatedAt))}
          </div>
        </section>

        ${card.notes
          ? html`
              <section class="workboard-detail__section">
                <h3>${t("workboard.fieldNotes")}</h3>
                <p>${card.notes}</p>
              </section>
            `
          : nothing}
        ${renderDetailList(t("workboard.fieldLabels"), card.labels)}
        ${renderDetailList(
          t("workboard.badgeAttempts", { count: String(attempts.length) }),
          attempts.map((entry) =>
            [entry.status, entry.model, entry.sessionKey, entry.error].filter(Boolean).join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.badgeLinks", { count: String(links.length) }),
          links.map((entry) =>
            [entry.type, entry.title, entry.targetCardId, entry.url].filter(Boolean).join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.detailProof"),
          proof.map((entry) =>
            [entry.status, entry.label, entry.command, entry.url, entry.note]
              .filter(Boolean)
              .join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.badgeArtifacts", { count: String(artifacts.length) }),
          artifacts.map((entry) =>
            [entry.label, entry.url, entry.path, entry.mimeType].filter(Boolean).join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.badgeAttachments", { count: String(attachments.length) }),
          attachments.map((entry) =>
            [entry.fileName, entry.mimeType, entry.note].filter(Boolean).join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.detailDiagnostics"),
          diagnostics.map((entry) => `${entry.severity}: ${entry.title}`),
        )}
        ${renderDetailList(
          t("workboard.detailWorkerLogs"),
          workerLogs.map((entry) => `${entry.level}: ${entry.message}`),
        )}
        ${workerProtocol
          ? renderDetailList(t("workboard.detailWorkerProtocol"), [
              workerProtocol.state,
              workerProtocol.detail ?? "",
              workerProtocol.updatedAt
                ? t("workboard.detailUpdatedValue", { time: formatTime(workerProtocol.updatedAt) })
                : "",
            ])
          : nothing}
        ${automation
          ? renderDetailList(t("workboard.detailAutomation"), [
              automation.tenant
                ? t("workboard.detailAutomationTenant", { tenant: automation.tenant })
                : "",
              automation.boardId
                ? t("workboard.detailAutomationBoard", { board: automation.boardId })
                : "",
              automation.skills?.length
                ? t("workboard.detailAutomationSkills", { skills: automation.skills.join(", ") })
                : "",
              automation.workspace
                ? t("workboard.detailAutomationWorkspace", {
                    workspace: [
                      automation.workspace.kind,
                      automation.workspace.path,
                      automation.workspace.branch,
                    ]
                      .filter(Boolean)
                      .join(" "),
                  })
                : "",
              automation.dispatchCount
                ? t("workboard.badgeDispatches", { count: String(automation.dispatchCount) })
                : "",
              automation.lastDispatchAt
                ? t("workboard.detailUpdatedValue", { time: formatTime(automation.lastDispatchAt) })
                : "",
              automation.summary
                ? t("workboard.detailAutomationSummary", { summary: automation.summary })
                : "",
            ])
          : nothing}
        ${renderDetailList(
          t("workboard.eventsLabel"),
          events.map((event) => `${formatEventLabel(event)} ${formatTime(event.at)}`),
        )}

        <section class="workboard-detail__section">
          <h3>${t("workboard.detailOperatorNotes")}</h3>
          ${comments.length
            ? html`
                <ol class="workboard-detail__list">
                  ${comments.slice(-6).map((comment) => html`<li>${comment.body}</li>`)}
                </ol>
              `
            : html`<p>${t("workboard.detailNoNotes")}</p>`}
          ${writable
            ? html`
                <textarea
                  class="input workboard-detail__note"
                  maxlength="2000"
                  placeholder=${t("workboard.detailNotePlaceholder")}
                  .value=${state.detailCommentBody}
                  @input=${(event: InputEvent) => {
                    state.detailCommentBody = (event.currentTarget as HTMLTextAreaElement).value;
                    props.onRequestUpdate?.();
                  }}
                ></textarea>
                <button
                  class="btn"
                  type="button"
                  ?disabled=${busy || !state.detailCommentBody.trim()}
                  @click=${() =>
                    addWorkboardCardComment({
                      host: props.host,
                      client: props.client,
                      cardId: card.id,
                      body: state.detailCommentBody,
                      requestUpdate: props.onRequestUpdate,
                    })}
                >
                  ${icons.plus} ${t("workboard.detailAddNote")}
                </button>
              `
            : nothing}
        </section>

        <div class="workboard-detail__actions">
          ${linkedSessionKey
            ? html`
                <button
                  class="btn"
                  type="button"
                  @click=${() => props.onOpenSession(linkedSessionKey)}
                >
                  ${icons.messageSquare} ${t("workboard.openSession")}
                </button>
              `
            : nothing}
          ${showStartControls ? renderStartExecutionControls(props, card) : nothing}
        </div>
      </div>
    </aside>
  `;
}

function renderDispatchSummary(state: WorkboardUiState) {
  const summary = state.lastDispatchSummary;
  if (!summary) {
    return nothing;
  }
  const total =
    summary.started +
    summary.failures +
    summary.promoted +
    summary.blocked +
    summary.reclaimed +
    summary.orchestrated;
  const key = total === 0 ? "workboard.dispatchSummaryEmpty" : "workboard.dispatchSummary";
  return html`
    <div class="callout">
      ${t(key, {
        started: String(summary.started),
        failures: String(summary.failures),
        promoted: String(summary.promoted),
        blocked: String(summary.blocked),
        reclaimed: String(summary.reclaimed),
        orchestrated: String(summary.orchestrated),
      })}
    </div>
  `;
}

function renderCard(props: WorkboardProps, card: WorkboardCard) {
  const state = getWorkboardState(props.host);
  const task = state.tasksByCardId.get(card.id);
  const session = findWorkboardSession(card, props.sessions);
  const busy = state.busyCardId === card.id;
  const syncing = state.syncingCardIds.has(card.id);
  const activeTask = taskIsActive(task);
  const live =
    activeTask ||
    session?.hasActiveRun === true ||
    (session?.hasActiveRun !== false && session?.status === "running");
  const linkedSessionKey = card.sessionKey ?? card.execution?.sessionKey;
  const writable = canMutate(props);
  const showStartControls = writable && cardCanStart(state, props.sessions, card);
  return html`
    <article
      class="workboard-card priority-${card.priority} ${busy
        ? "workboard-card--busy"
        : ""} workboard-card--openable"
      role="button"
      tabindex="0"
      title=${t("workboard.viewDetails")}
      draggable=${writable ? "true" : "false"}
      @click=${(event: MouseEvent) => {
        if (!isCardActionTarget(event)) {
          openCardDetails(state, card);
          props.onRequestUpdate?.();
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (isCardActionTarget(event) || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        openCardDetails(state, card);
        props.onRequestUpdate?.();
        event.preventDefault();
      }}
      @dragstart=${(event: DragEvent) => {
        if (!writable) {
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
        <span class="workboard-card__priority">${card.priority}</span>
        ${live ? html`<span class="workboard-live">${t("workboard.live")}</span>` : nothing}
        ${syncing ? html`<span class="workboard-live">${t("common.saving")}</span>` : nothing}
      </div>
      <h3>${card.title}</h3>
      ${card.notes ? html`<p>${card.notes}</p>` : nothing}
      ${renderLifecycle(card, props.sessions, task)}
      ${card.labels.length
        ? html`<div class="workboard-labels">
            ${card.labels.map((label) => html`<span>${label}</span>`)}
          </div>`
        : nothing}
      ${renderCompactBadges(card, task)}
      <div class="workboard-card__meta">
        ${card.agentId
          ? html`<span>${card.agentId}</span>`
          : html`<span>${t("workboard.defaultAgent")}</span>`}
        <span>${formatTime(card.updatedAt)}</span>
      </div>
      ${renderEvents(card)}
      <div class="workboard-card__actions">
        <button
          class="btn btn--icon workboard-card__icon"
          title=${t("workboard.viewDetails")}
          @click=${() => {
            openCardDetails(state, card);
            props.onRequestUpdate?.();
          }}
        >
          ${icons.panelRightOpen}
        </button>
        ${writable
          ? html`
              <button
                class="btn btn--icon workboard-card__icon"
                title=${t("workboard.editCard")}
                @click=${() => {
                  openEditModal(state, card);
                  props.onRequestUpdate?.();
                }}
              >
                ${icons.edit}
              </button>
            `
          : nothing}
        ${linkedSessionKey
          ? html`
              <button
                class="btn btn--icon workboard-card__icon"
                title=${t("workboard.openSession")}
                @click=${() => props.onOpenSession(linkedSessionKey)}
              >
                ${icons.messageSquare}
              </button>
              ${writable && live
                ? html`
                    <button
                      class="btn btn--icon workboard-card__icon"
                      title=${t("workboard.stopSession")}
                      ?disabled=${busy || !props.connected}
                      @click=${() =>
                        stopWorkboardCard({
                          host: props.host,
                          client: props.client,
                          card,
                          requestUpdate: props.onRequestUpdate,
                        })}
                    >
                      ${icons.stop}
                    </button>
                  `
                : nothing}
            `
          : nothing}
        ${!linkedSessionKey && writable && activeTask
          ? html`
              <button
                class="btn btn--icon workboard-card__icon"
                title=${t("workboard.stopSession")}
                ?disabled=${busy || !props.connected}
                @click=${() =>
                  stopWorkboardCard({
                    host: props.host,
                    client: props.client,
                    card,
                    requestUpdate: props.onRequestUpdate,
                  })}
              >
                ${icons.stop}
              </button>
            `
          : nothing}
        ${showStartControls ? renderStartExecutionButton(props, card, null, "autonomous") : nothing}
        ${writable
          ? html`
              <button
                class="btn btn--icon workboard-card__icon"
                title=${t("workboard.archiveCard")}
                ?disabled=${busy}
                @click=${() =>
                  archiveWorkboardCard({
                    host: props.host,
                    client: props.client,
                    cardId: card.id,
                    requestUpdate: props.onRequestUpdate,
                  })}
              >
                ${icons.check}
              </button>
              <button
                class="btn btn--icon workboard-card__icon workboard-card__delete"
                title=${t("workboard.deleteCard")}
                ?disabled=${busy}
                @click=${() =>
                  deleteWorkboardCard({
                    host: props.host,
                    client: props.client,
                    cardId: card.id,
                    requestUpdate: props.onRequestUpdate,
                  })}
              >
                ${icons.trash}
              </button>
            `
          : nothing}
      </div>
    </article>
  `;
}

function renderColumn(props: WorkboardProps, status: WorkboardStatus, cards: WorkboardCard[]) {
  const state = getWorkboardState(props.host);
  const writable = canMutate(props);
  return html`
    <section
      class="workboard-column ${state.draggedCardId ? "workboard-column--drop" : ""}"
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
        if (!cardId) {
          return;
        }
        void moveWorkboardCard({
          host: props.host,
          client: props.client,
          cardId,
          status,
          position: nextPosition(state.cards, status),
          requestUpdate: props.onRequestUpdate,
        });
      }}
    >
      <div class="workboard-column__header">
        <h2>${formatStatusLabel(status)}</h2>
        <span>${cards.length}</span>
      </div>
      <div class="workboard-column__cards">
        ${cards.length
          ? cards.map((card) => renderCard(props, card))
          : html`<div class="workboard-empty">${t("workboard.emptyColumn")}</div>`}
      </div>
    </section>
  `;
}

export function renderWorkboard(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  if (props.pluginEnabled) {
    void loadWorkboard({
      host: props.host,
      client: props.client,
      requestUpdate: props.onRequestUpdate,
    });
    void syncWorkboardLifecycle({
      host: props.host,
      client: props.client,
      sessions: props.sessions,
      canWrite: props.canWrite,
      requestUpdate: props.onRequestUpdate,
    });
  }

  if (!props.pluginEnabled) {
    return html`
      <section class="workboard">
        <div class="callout">
          ${t("workboard.disabledHelpStart")}
          <code>${t("workboard.enableConfigKey")}</code>${t("workboard.disabledHelpEnd")}
        </div>
      </section>
    `;
  }

  const filtered = state.cards
    .filter((card) => !card.metadata?.archivedAt)
    .filter((card) => matchesFilter(card, { query: state.query, priority: state.priorityFilter }));
  const writable = canMutate(props);
  const byStatus = new Map<WorkboardStatus, WorkboardCard[]>();
  for (const status of state.statuses) {
    byStatus.set(status, []);
  }
  for (const card of filtered) {
    byStatus.get(card.status)?.push(card);
  }

  return html`
    <section class="workboard">
      <div class="workboard-toolbar">
        <div class="workboard-toolbar__filters">
          <input
            class="input"
            type="search"
            placeholder=${t("workboard.searchPlaceholder")}
            .value=${state.query}
            @input=${(event: InputEvent) => {
              state.query = (event.currentTarget as HTMLInputElement).value;
              props.onRequestUpdate?.();
            }}
          />
          <select
            class="input"
            .value=${state.priorityFilter}
            @change=${(event: Event) => {
              state.priorityFilter = (event.currentTarget as HTMLSelectElement)
                .value as WorkboardUiState["priorityFilter"];
              props.onRequestUpdate?.();
            }}
          >
            <option value="all">${t("workboard.allPriorities")}</option>
            ${WORKBOARD_PRIORITIES.map(
              (priority) => html`<option value=${priority}>${priority}</option>`,
            )}
          </select>
        </div>
        <div class="workboard-toolbar__actions">
          <button
            class="btn"
            ?disabled=${state.loading}
            @click=${() =>
              loadWorkboard({
                host: props.host,
                client: props.client,
                requestUpdate: props.onRequestUpdate,
                force: true,
              })}
          >
            ${state.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
          ${writable
            ? html`
                <button
                  class="btn"
                  ?disabled=${state.loading}
                  @click=${() =>
                    dispatchWorkboard({
                      host: props.host,
                      client: props.client,
                      requestUpdate: props.onRequestUpdate,
                    })}
                >
                  ${icons.zap} ${t("workboard.dispatch")}
                </button>
              `
            : nothing}
          ${writable
            ? html`
                <button
                  class="btn primary"
                  @click=${() => {
                    openCreateModal(state);
                    props.onRequestUpdate?.();
                  }}
                >
                  ${icons.plus} ${t("workboard.newCard")}
                </button>
              `
            : nothing}
        </div>
      </div>
      ${state.error ? html`<div class="callout danger">${state.error}</div>` : nothing}
      ${renderDispatchSummary(state)} ${renderCardModal(props)} ${renderCardDetailsPanel(props)}
      <div class="workboard-board">
        ${state.statuses.map((status) => renderColumn(props, status, byStatus.get(status) ?? []))}
      </div>
    </section>
  `;
}
