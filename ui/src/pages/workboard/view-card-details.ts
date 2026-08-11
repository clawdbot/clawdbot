import { html, nothing } from "lit";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  addWorkboardCardComment,
  getWorkboardDependencyState,
  getWorkboardLifecycle,
  getWorkboardState,
  type WorkboardCard,
  type WorkboardDependencyState,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import {
  getCardActionState,
  renderArchiveCardAction,
  renderCardMoveControl,
  renderDeleteCardAction,
  renderEditCardAction,
  renderOpenSessionCardAction,
  renderStartExecutionControls,
  renderStopCardAction,
} from "./view-card-actions.ts";
import {
  formatEventLabel,
  formatLifecycle,
  formatPriorityLabel,
  formatStatusLabel,
  formatUpdatedTime,
  taskDetail,
  taskMatchesLifecycle,
  type WorkboardProps,
} from "./view-helpers.ts";

export const workboardCardDetailDrawerId = "workboard-card-detail-drawer";
const workboardCardDetailTitleId = "workboard-card-detail-title";
const workboardCardDetailDescriptionId = "workboard-card-detail-description";

function ensureWorkboardCardDashboardElement(): Promise<void> {
  return ensureCustomElementDefined(
    "openclaw-workboard-card-dashboard",
    () => import("./workboard-card-dashboard.ts"),
  );
}

export function openCardDetails(state: WorkboardUiState, card: WorkboardCard) {
  state.detailCardId = card.id;
  state.detailCommentBody = "";
}

function closeCardDetails(state: WorkboardUiState) {
  state.detailCardId = null;
  state.detailCommentBody = "";
}

export function getVisibleDetailCard(state: WorkboardUiState): WorkboardCard | null {
  if (!state.detailCardId || state.draftOpen) {
    return null;
  }
  const card = state.cards.find((entry) => entry.id === state.detailCardId) ?? null;
  if (!card || (card.metadata?.archivedAt && !state.showArchived)) {
    return null;
  }
  return card;
}

function renderDependencyDetailList(dependencies: WorkboardDependencyState) {
  if (dependencies.parents.length === 0) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${t("workboard.dependencies")}</h3>
      <ul class="workboard-detail__list workboard-detail__dependencies">
        ${dependencies.parents.map(
          (parent) => html`
            <li class=${parent.done ? "is-done" : "is-blocked"}>
              ${parent.done
                ? html`<span class="workboard-detail__dependency-spacer"></span>`
                : icons.alertTriangle}
              <span>${parent.title}</span>
              <span>
                ${parent.missing
                  ? t("workboard.dependencyStatusMissing")
                  : parent.status
                    ? formatStatusLabel(parent.status)
                    : t("workboard.unknownStatus")}
              </span>
            </li>
          `,
        )}
      </ul>
    </section>
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

function renderDetailList(title: string, values: readonly string[]) {
  const entries = values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(-6);
  if (entries.length === 0) {
    return nothing;
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

function joinDetailParts(...values: unknown[]): string {
  return values.filter(Boolean).join(" - ");
}

function detailValues<T>(entries: readonly T[], ...fields: Array<keyof T>): string[] {
  return entries.map((entry) => joinDetailParts(...fields.map((field) => entry[field])));
}

export function renderCardDetailsPanel(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const card = getVisibleDetailCard(state);
  if (!card) {
    return nothing;
  }
  const { task, busy, activeTask, live, linkedSessionKey, writable, showStartControls, archived } =
    getCardActionState(props, card);
  if (linkedSessionKey) {
    void ensureWorkboardCardDashboardElement().catch(() => undefined);
  }
  const lifecycle = getWorkboardLifecycle(card, props.sessions, task);
  const formatted = formatLifecycle(lifecycle);
  const taskIsAuthoritative = task ? taskMatchesLifecycle(task, lifecycle) : false;
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
  const dependencies = getWorkboardDependencyState(card, state.cards);
  const detailSections: Array<readonly [string, readonly string[]]> = [
    [t("workboard.fieldLabels"), card.labels],
    [
      t("workboard.badgeAttempts", { count: String(attempts.length) }),
      detailValues(attempts, "status", "model", "sessionKey", "error"),
    ],
    [
      t("workboard.badgeLinks", { count: String(links.length) }),
      detailValues(links, "type", "title", "targetCardId", "url"),
    ],
    [t("workboard.detailProof"), detailValues(proof, "status", "label", "command", "url", "note")],
    [
      t("workboard.badgeArtifacts", { count: String(artifacts.length) }),
      detailValues(artifacts, "label", "url", "path", "mimeType"),
    ],
    [
      t("workboard.badgeAttachments", { count: String(attachments.length) }),
      detailValues(attachments, "fileName", "mimeType", "note"),
    ],
    [
      t("workboard.detailDiagnostics"),
      diagnostics.map((entry) => `${entry.severity}: ${entry.title}`),
    ],
    [
      t("workboard.detailWorkerLogs"),
      workerLogs.map((entry) => `${entry.level}: ${entry.message}`),
    ],
    [
      t("workboard.detailWorkerProtocol"),
      workerProtocol
        ? [
            workerProtocol.state,
            workerProtocol.detail ?? "",
            workerProtocol.updatedAt
              ? t("workboard.detailUpdatedValue", {
                  time: formatUpdatedTime(workerProtocol.updatedAt),
                })
              : "",
          ]
        : [],
    ],
    [
      t("workboard.detailAutomation"),
      automation
        ? [
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
              ? t("workboard.detailUpdatedValue", {
                  time: formatUpdatedTime(automation.lastDispatchAt),
                })
              : "",
            automation.summary
              ? t("workboard.detailAutomationSummary", { summary: automation.summary })
              : "",
          ]
        : [],
    ],
    [
      t("workboard.eventsLabel"),
      events.map((event) => `${formatEventLabel(event)} ${formatUpdatedTime(event.at)}`),
    ],
  ];
  return html`
    <openclaw-modal-dialog
      class="drawer"
      label=${card.title}
      description=${task && taskIsAuthoritative
        ? taskDetail(task)
        : (lifecycle.session?.displayName ?? formatted.detail)}
      style="--openclaw-modal-width: min(460px, 100vw); --openclaw-modal-max-height: 100dvh;"
      @modal-cancel=${() => {
        closeCardDetails(state);
        props.onRequestUpdate?.();
      }}
    >
      <aside id=${workboardCardDetailDrawerId} class="workboard-detail-drawer">
        <div class="workboard-detail">
          <header class="workboard-detail__header">
            <div>
              <span class="workboard-card__priority">${formatPriorityLabel(card.priority)}</span>
              <h2 id=${workboardCardDetailTitleId}>
                <span class="workboard-sr-only">${t("workboard.detailTitle")}: </span>${card.title}
              </h2>
            </div>
            <openclaw-tooltip .content=${t("common.cancel")}>
              <button
                class="btn btn--icon workboard-card__icon"
                type="button"
                aria-label=${t("common.cancel")}
                @click=${() => {
                  closeCardDetails(state);
                  props.onRequestUpdate?.();
                }}
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>
          </header>

          <section class="workboard-detail__section">
            <div class="workboard-card__lifecycle">
              <span class="workboard-lifecycle workboard-lifecycle--${formatted.tone}">
                ${formatted.label}
              </span>
              <span id=${workboardCardDetailDescriptionId} class="workboard-card__lifecycle-detail">
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
              ${renderDetailRow(t("workboard.detailUpdated"), formatUpdatedTime(card.updatedAt))}
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
          ${linkedSessionKey
            ? html`
                <openclaw-workboard-card-dashboard
                  .sessionKey=${linkedSessionKey}
                  .client=${props.client}
                  .connected=${props.connected}
                  .canMutate=${props.canWrite !== false}
                  .canGrant=${props.canGrant === true}
                ></openclaw-workboard-card-dashboard>
              `
            : nothing}
          ${renderDependencyDetailList(dependencies)}
          ${detailSections.map(([title, values]) => renderDetailList(title, values))}

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
            ${writable && !archived ? renderEditCardAction(props, card) : nothing}
            ${writable ? renderArchiveCardAction(props, card, busy, archived) : nothing}
            ${writable && !archived
              ? renderCardMoveControl(props, card, busy, { wide: true })
              : nothing}
            ${writable && (linkedSessionKey ? live : activeTask)
              ? renderStopCardAction(props, card, busy)
              : nothing}
            ${renderOpenSessionCardAction(props, linkedSessionKey)}
            ${writable ? renderDeleteCardAction(props, card, busy) : nothing}
            ${showStartControls ? renderStartExecutionControls(props, card) : nothing}
          </div>
        </div>
      </aside>
    </openclaw-modal-dialog>
  `;
}
