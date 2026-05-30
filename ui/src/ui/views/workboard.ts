import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import {
  archiveWorkboardCard,
  deleteWorkboardCard,
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
  type WorkboardTemplateId,
  type WorkboardUiState,
} from "../controllers/workboard.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { icons } from "../icons.ts";
import type { AgentsListResult, GatewaySessionRow } from "../types.ts";

type WorkboardProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  canWrite?: boolean;
  pluginEnabled: boolean;
  agentsList: AgentsListResult | null;
  sessions: GatewaySessionRow[];
  onOpenSession: (sessionKey: string) => void;
  onRequestUpdate?: () => void;
};

const WORKBOARD_GAME_SIZE = 5;
const WORKBOARD_GAME_GOAL = WORKBOARD_GAME_SIZE * WORKBOARD_GAME_SIZE - 1;
const WORKBOARD_GAME_BLOCKERS = new Set([6, 8, 12, 16, 18]);
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
  return new Date(value).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
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
    case "diagnostic":
      return t("workboard.eventDiagnostic");
    case "notification":
      return t("workboard.eventNotification");
    case "dispatch":
      return t("workboard.eventDispatch");
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

function renderMetadataBadges(card: WorkboardCard) {
  const metadata = card.metadata;
  if (!metadata) {
    return nothing;
  }
  const badges = [
    metadata.templateId ? t(`workboard.template.${metadata.templateId}`) : null,
    metadata.attempts?.length
      ? t("workboard.badgeAttempts", { count: String(metadata.attempts.length) })
      : null,
    metadata.failureCount
      ? t("workboard.badgeFailures", { count: String(metadata.failureCount) })
      : null,
    metadata.comments?.length
      ? t("workboard.badgeComments", { count: String(metadata.comments.length) })
      : null,
    metadata.links?.length
      ? t("workboard.badgeLinks", { count: String(metadata.links.length) })
      : null,
    metadata.proof?.length
      ? t("workboard.badgeProof", { count: String(metadata.proof.length) })
      : null,
    metadata.artifacts?.length
      ? t("workboard.badgeArtifacts", { count: String(metadata.artifacts.length) })
      : null,
    metadata.automation?.tenant
      ? t("workboard.badgeTenant", { tenant: metadata.automation.tenant })
      : null,
    metadata.automation?.skills?.length
      ? t("workboard.badgeSkills", { count: String(metadata.automation.skills.length) })
      : null,
    metadata.automation?.dispatchCount
      ? t("workboard.badgeDispatches", { count: String(metadata.automation.dispatchCount) })
      : null,
    metadata.claim ? t("workboard.badgeClaimed", { owner: metadata.claim.ownerId }) : null,
    metadata.diagnostics?.length
      ? t("workboard.badgeDiagnostics", { count: String(metadata.diagnostics.length) })
      : null,
    metadata.stale ? t("workboard.badgeStale") : null,
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

function openCardSession(
  props: Pick<WorkboardProps, "onOpenSession">,
  card: WorkboardCard,
): boolean {
  const sessionKey = card.sessionKey ?? card.execution?.sessionKey;
  if (!sessionKey) {
    return false;
  }
  props.onOpenSession(sessionKey);
  return true;
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
}

function openCreateModal(state: WorkboardUiState) {
  resetDraft(state);
  state.draftOpen = true;
}

function resetGame(state: WorkboardUiState) {
  state.gamePlayerIndex = 0;
  state.gameMoves = 0;
  state.gameMessage = "workboard.gameStart";
}

function moveGamePlayer(state: WorkboardUiState, delta: number) {
  if (state.gamePlayerIndex === WORKBOARD_GAME_GOAL) {
    resetGame(state);
  }
  const currentRow = Math.floor(state.gamePlayerIndex / WORKBOARD_GAME_SIZE);
  const nextIndex = state.gamePlayerIndex + delta;
  const nextRow = Math.floor(nextIndex / WORKBOARD_GAME_SIZE);
  if (
    nextIndex < 0 ||
    nextIndex > WORKBOARD_GAME_GOAL ||
    (delta === -1 && nextRow !== currentRow) ||
    (delta === 1 && nextRow !== currentRow)
  ) {
    state.gameMessage = "workboard.gameBoundary";
    return;
  }
  if (WORKBOARD_GAME_BLOCKERS.has(nextIndex)) {
    state.gameMessage = "workboard.gameBlocked";
    return;
  }
  state.gamePlayerIndex = nextIndex;
  state.gameMoves += 1;
  state.gameMessage =
    nextIndex === WORKBOARD_GAME_GOAL ? "workboard.gameWin" : "workboard.gameContinue";
  if (nextIndex === WORKBOARD_GAME_GOAL) {
    state.gameWins += 1;
  }
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

function renderGameArrow(
  label: string,
  className: string,
  delta: number,
  props: Pick<WorkboardProps, "host" | "onRequestUpdate">,
) {
  const state = getWorkboardState(props.host);
  return html`
    <button
      class="btn btn--icon workboard-game__arrow ${className}"
      type="button"
      title=${label}
      aria-label=${label}
      @click=${() => {
        moveGamePlayer(state, delta);
        props.onRequestUpdate?.();
      }}
    >
      ${icons.arrowDown}
    </button>
  `;
}

function renderGameModal(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  if (!state.gameOpen) {
    return nothing;
  }
  return html`
    <div
      class="workboard-modal"
      role="presentation"
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) {
          state.gameOpen = false;
          props.onRequestUpdate?.();
        }
      }}
    >
      <div
        class="workboard-game"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workboard-game-title"
        tabindex="0"
        @keydown=${(event: KeyboardEvent) => {
          const moves: Record<string, number> = {
            ArrowDown: WORKBOARD_GAME_SIZE,
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -WORKBOARD_GAME_SIZE,
          };
          const delta = moves[event.key];
          if (typeof delta !== "number") {
            return;
          }
          event.preventDefault();
          moveGamePlayer(state, delta);
          props.onRequestUpdate?.();
        }}
      >
        <div class="workboard-modal__header">
          <div>
            <h2 id="workboard-game-title">${t("workboard.gameTitle")}</h2>
            <p>${t(state.gameMessage)}</p>
          </div>
          <button
            class="btn btn--icon workboard-card__icon"
            type="button"
            title=${t("common.cancel")}
            @click=${() => {
              state.gameOpen = false;
              props.onRequestUpdate?.();
            }}
          >
            ${icons.x}
          </button>
        </div>
        <div class="workboard-game__stats">
          <span>${t("workboard.gameMoves", { count: String(state.gameMoves) })}</span>
          <span>${t("workboard.gameWins", { count: String(state.gameWins) })}</span>
        </div>
        <div class="workboard-game__grid" role="grid" aria-label=${t("workboard.gameBoard")}>
          ${Array.from({ length: WORKBOARD_GAME_SIZE * WORKBOARD_GAME_SIZE }, (_, index) => {
            const player = index === state.gamePlayerIndex;
            const goal = index === WORKBOARD_GAME_GOAL;
            const blocker = WORKBOARD_GAME_BLOCKERS.has(index);
            return html`
              <div
                class="workboard-game__cell ${player ? "workboard-game__cell--player" : ""} ${goal
                  ? "workboard-game__cell--goal"
                  : ""} ${blocker ? "workboard-game__cell--blocker" : ""}"
                role="gridcell"
                aria-label=${player
                  ? t("workboard.gameAgent")
                  : goal
                    ? t("workboard.gameLaunch")
                    : blocker
                      ? t("workboard.gameBlockedCell")
                      : t("workboard.gameOpenCell")}
              >
                ${player ? "A" : goal ? "L" : blocker ? "" : ""}
              </div>
            `;
          })}
        </div>
        <div class="workboard-game__controls" aria-label=${t("workboard.gameControls")}>
          ${renderGameArrow(
            t("workboard.gameMoveUp"),
            "workboard-game__arrow--up",
            -WORKBOARD_GAME_SIZE,
            props,
          )}
          ${renderGameArrow(t("workboard.gameMoveLeft"), "workboard-game__arrow--left", -1, props)}
          ${renderGameArrow(t("workboard.gameMoveDown"), "", WORKBOARD_GAME_SIZE, props)}
          ${renderGameArrow(t("workboard.gameMoveRight"), "workboard-game__arrow--right", 1, props)}
        </div>
        <div class="workboard-modal__actions">
          <button
            class="btn"
            type="button"
            @click=${() => {
              resetGame(state);
              props.onRequestUpdate?.();
            }}
          >
            ${t("common.reset")}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderCardModal(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const agents = props.agentsList?.agents ?? [];
  const sessions = props.sessions.filter(isWorkboardSessionChoice);
  if (!state.draftOpen) {
    return nothing;
  }
  const editing = Boolean(state.editingCardId);
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
        <div class="workboard-modal__actions">
          <button class="btn primary" ?disabled=${state.loading || !state.draftTitle.trim()}>
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

function renderLifecycle(card: WorkboardCard, sessions: readonly GatewaySessionRow[]) {
  const lifecycle = getWorkboardLifecycle(card, sessions);
  const formatted = formatLifecycle(lifecycle);
  const session = lifecycle.session;
  const execution = card.execution;
  const stale = lifecycle.state === "stale";
  return html`
    <div class="workboard-card__lifecycle">
      <span class="workboard-lifecycle workboard-lifecycle--${formatted.tone}">
        ${stale || !execution ? formatted.label : `${execution.engine} ${execution.mode}`}
      </span>
      <span class="workboard-card__lifecycle-detail">
        ${stale ? formatted.detail : (session?.displayName ?? session?.label ?? formatted.detail)}
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
  return html`
    <div class="workboard-card__execution-controls">
      ${renderStartExecutionButton(props, card, null, "autonomous")}
      ${renderStartExecutionButton(props, card, "codex", "autonomous")}
      ${renderStartExecutionButton(props, card, "claude", "autonomous")}
      ${renderStartExecutionButton(props, card, "codex", "manual")}
      ${renderStartExecutionButton(props, card, "claude", "manual")}
    </div>
  `;
}

function renderCard(props: WorkboardProps, card: WorkboardCard) {
  const state = getWorkboardState(props.host);
  const session = findWorkboardSession(card, props.sessions);
  const busy = state.busyCardId === card.id;
  const syncing = state.syncingCardIds.has(card.id);
  const live =
    session?.hasActiveRun === true ||
    (session?.hasActiveRun !== false && session?.status === "running");
  const linkedSessionKey = card.sessionKey ?? card.execution?.sessionKey;
  const linked = Boolean(linkedSessionKey);
  const writable = canMutate(props);
  const showStartControls = writable && (!linked || !session);
  return html`
    <article
      class="workboard-card priority-${card.priority} ${busy ? "workboard-card--busy" : ""} ${linked
        ? "workboard-card--openable"
        : ""}"
      role=${linked ? "button" : nothing}
      tabindex=${linked ? 0 : nothing}
      title=${linked ? t("workboard.openLinkedSession") : nothing}
      draggable=${writable ? "true" : "false"}
      @click=${(event: MouseEvent) => {
        if (!isCardActionTarget(event)) {
          openCardSession(props, card);
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (isCardActionTarget(event) || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        if (openCardSession(props, card)) {
          event.preventDefault();
        }
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
      ${card.notes ? html`<p>${card.notes}</p>` : nothing} ${renderLifecycle(card, props.sessions)}
      ${card.labels.length
        ? html`<div class="workboard-labels">
            ${card.labels.map((label) => html`<span>${label}</span>`)}
          </div>`
        : nothing}
      ${renderMetadataBadges(card)}
      <div class="workboard-card__meta">
        ${card.agentId
          ? html`<span>${card.agentId}</span>`
          : html`<span>${t("workboard.defaultAgent")}</span>`}
        <span>${formatTime(card.updatedAt)}</span>
      </div>
      ${renderEvents(card)}
      <div class="workboard-card__actions">
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
        ${linked
          ? html`
              <button
                class="btn btn--icon workboard-card__icon"
                title=${t("workboard.openSession")}
                @click=${() => props.onOpenSession(linkedSessionKey!)}
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
        ${showStartControls ? renderStartExecutionControls(props, card) : nothing}
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
          <button
            class="btn"
            @click=${() => {
              state.gameOpen = true;
              props.onRequestUpdate?.();
            }}
          >
            ${icons.play} ${t("workboard.gameButton")}
          </button>
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
      ${renderGameModal(props)} ${renderCardModal(props)}
      <div class="workboard-board">
        ${state.statuses.map((status) => renderColumn(props, status, byStatus.get(status) ?? []))}
      </div>
    </section>
  `;
}
