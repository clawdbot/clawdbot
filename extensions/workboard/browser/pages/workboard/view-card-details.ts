import { html, nothing } from "lit";
import { renderDashboard, renderDialog } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import {
  addWorkboardCardComment,
  decodeWorkboardAttachmentText,
  deleteWorkboardAttachment,
  downloadWorkboardAttachment,
  formatWorkboardAttachmentBytes,
  getWorkboardDependencyState,
  getWorkboardLifecycle,
  getWorkboardState,
  inspectWorkboardAttachment,
  workboardAttachmentDataUrl,
  workboardAttachmentMediaType,
  workboardAttachmentMimeType,
  type WorkboardCard,
  type WorkboardAttachment,
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
  renderWorkboardError,
  taskDetail,
  taskMatchesLifecycle,
  type WorkboardProps,
} from "./view-helpers.ts";

export const workboardCardDetailDrawerId = "workboard-card-detail-drawer";
const workboardCardDetailTitleId = "workboard-card-detail-title";
const workboardCardDetailDescriptionId = "workboard-card-detail-description";

export function openCardDetails(state: WorkboardUiState, card: WorkboardCard) {
  state.detailCardId = card.id;
  state.detailCommentBody = "";
  state.attachmentPreviewRequestId += 1;
  state.attachmentPreview = null;
  state.attachmentPreviewTrigger = null;
}

function closeCardDetails(state: WorkboardUiState) {
  state.detailCardId = null;
  state.detailCommentBody = "";
  state.attachmentPreviewRequestId += 1;
  state.attachmentPreview = null;
  state.attachmentPreviewTrigger = null;
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
              ${
                parent.done
                  ? html`<span class="workboard-detail__dependency-spacer"></span>`
                  : icons.alertTriangle
              }
              <span>${parent.title}</span>
              <span>
                ${
                  parent.missing
                    ? t("workboard.dependencyStatusMissing")
                    : parent.status
                      ? formatStatusLabel(parent.status)
                      : t("workboard.unknownStatus")
                }
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

function renderAttachmentPreview(
  props: WorkboardProps,
  preview: WorkboardUiState["attachmentPreview"],
) {
  if (!preview) {
    return nothing;
  }
  const mimeType = workboardAttachmentMimeType(preview.attachment);
  const mediaType = workboardAttachmentMediaType(preview.attachment);
  const dataUrl = workboardAttachmentDataUrl(preview.attachment, preview.contentBase64);
  const textPreview = mediaType.startsWith("text/")
    ? decodeWorkboardAttachmentText(preview.contentBase64)
    : null;
  return html`
    <div
      class="workboard-attachment-preview"
      role="region"
      aria-label=${preview.attachment.fileName}
    >
      <div class="workboard-attachment-preview__header">
        <strong>${preview.attachment.fileName}</strong>
        <button
          class="btn btn--icon workboard-card__icon"
          type="button"
          aria-label=${t("workboard.attachmentsPreviewClose")}
          @click=${() => {
            const state = getWorkboardState(props.host);
            const trigger = state.attachmentPreviewTrigger;
            state.attachmentPreviewRequestId += 1;
            state.attachmentPreview = null;
            state.attachmentPreviewTrigger = null;
            trigger?.focus();
            props.onRequestUpdate?.();
          }}
        >
          ${icons.x}
        </button>
      </div>
      ${
        mediaType.startsWith("image/")
          ? html`<img
              class="workboard-attachment-preview__image"
              src=${dataUrl}
              alt=${preview.attachment.fileName}
            />`
          : mediaType.startsWith("text/") && textPreview !== null
            ? html`<pre class="workboard-attachment-preview__text">${textPreview}</pre>`
            : mediaType === "application/pdf"
              ? html`<object
                  class="workboard-attachment-preview__document"
                  data=${dataUrl}
                  type=${mimeType}
                  aria-label=${preview.attachment.fileName}
                >
                  <p>${t("workboard.attachmentsPreviewUnavailable")}</p>
                </object>`
              : html`<p>${t("workboard.attachmentsPreviewUnavailable")}</p>`
      }
    </div>
  `;
}

function renderAttachmentDetails(
  props: WorkboardProps,
  card: WorkboardCard,
  attachments: readonly WorkboardAttachment[],
  writable: boolean,
) {
  if (attachments.length === 0) {
    return nothing;
  }
  const state = getWorkboardState(props.host);
  return html`
    <section class="workboard-detail__section workboard-attachment-details">
      <div class="workboard-attachment-details__header">
        <h3>${t("workboard.attachmentsTitle")}</h3>
        <span
          >${t("workboard.attachmentsLimits", { count: String(attachments.length), max: "20" })}</span
        >
      </div>
      <ul class="workboard-detail__list workboard-attachment-details__list">
        ${attachments.map((attachment) => {
          const busy = state.attachmentBusyIds.has(attachment.id);
          const fileLabel = attachment.fileName;
          return html`
            <li>
              <div class="workboard-attachment-details__metadata">
                <strong title=${fileLabel}>${fileLabel}</strong>
                <small>
                  ${t("workboard.attachmentsFileInfo", {
                    size: formatWorkboardAttachmentBytes(attachment.byteSize),
                    mime: attachment.mimeType ?? t("common.na"),
                  })}
                </small>
                ${attachment.note ? html`<span>${attachment.note}</span>` : nothing}
              </div>
              <div class="workboard-attachment-details__actions">
                <button
                  class="btn btn--xs"
                  type="button"
                  data-workboard-attachment-id=${attachment.id}
                  data-workboard-attachment-action="inspect"
                  ?disabled=${busy || !props.client || !props.connected}
                  @click=${(event: Event) =>
                    inspectWorkboardAttachment({
                      host: props.host,
                      client: props.client,
                      attachment,
                      trigger:
                        event.currentTarget instanceof HTMLButtonElement
                          ? event.currentTarget
                          : null,
                      requestUpdate: props.onRequestUpdate,
                    })}
                >
                  ${icons.eye} ${t("workboard.attachmentsInspect", { file: fileLabel })}
                </button>
                <button
                  class="btn btn--xs"
                  type="button"
                  data-workboard-attachment-id=${attachment.id}
                  data-workboard-attachment-action="download"
                  ?disabled=${busy || !props.client || !props.connected}
                  @click=${() =>
                    downloadWorkboardAttachment({
                      host: props.host,
                      client: props.client,
                      attachment,
                      requestUpdate: props.onRequestUpdate,
                    })}
                >
                  ${t("workboard.attachmentsDownload", { file: fileLabel })}
                </button>
                ${
                  writable
                    ? html`<button
                        class="btn btn--xs workboard-card__delete"
                        type="button"
                        data-workboard-attachment-id=${attachment.id}
                        data-workboard-attachment-action="delete"
                        ?disabled=${busy || !props.client || !props.connected}
                        @click=${(event: Event) => {
                          if (
                            !window.confirm(
                              t("workboard.attachmentsDeleteConfirm", { file: fileLabel }),
                            )
                          ) {
                            return;
                          }
                          void deleteWorkboardAttachment({
                            host: props.host,
                            client: props.client,
                            cardId: card.id,
                            attachmentId: attachment.id,
                            trigger:
                              event.currentTarget instanceof HTMLButtonElement
                                ? event.currentTarget
                                : null,
                            requestUpdate: props.onRequestUpdate,
                          });
                        }}
                      >
                        ${icons.trash} ${t("workboard.attachmentsDelete", { file: fileLabel })}
                      </button>`
                    : nothing
                }
              </div>
            </li>
          `;
        })}
      </ul>
      ${
        state.attachmentPreview?.attachment.cardId === card.id
          ? renderAttachmentPreview(props, state.attachmentPreview)
          : nothing
      }
    </section>
  `;
}

export function renderCardDetailsPanel(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const card = getVisibleDetailCard(state);
  if (!card) {
    return nothing;
  }
  const {
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
  const lifecycle = getWorkboardLifecycle(card, props.sessions, task, props.sessionResolution);
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
      attempts.map((entry) =>
        joinDetailParts(
          entry.status,
          entry.model,
          entry.sessionKey,
          formatUiExternalText(entry.error),
        ),
      ),
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
      t("workboard.detailDiagnostics"),
      diagnostics.map((entry) => `${entry.severity}: ${entry.title}`),
    ],
    [
      t("workboard.detailWorkerLogs"),
      workerLogs.map((entry) => `${entry.level}: ${formatUiExternalText(entry.message)}`),
    ],
    [
      t("workboard.detailWorkerProtocol"),
      workerProtocol
        ? [
            workerProtocol.state,
            formatUiExternalText(workerProtocol.detail),
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
  return renderDialog(
    {
      className: "drawer",
      label: card.title,
      description:
        task && taskIsAuthoritative
          ? taskDetail(task)
          : (lifecycle.session?.displayName ?? formatted.detail),
      style: "--openclaw-modal-width: min(460px, 100vw); --openclaw-modal-max-height: 100dvh;",
      onCancel: () => {
        closeCardDetails(state);
        props.onRequestUpdate?.();
      },
    },
    html`
      <aside id=${workboardCardDetailDrawerId} class="workboard-detail-drawer">
        <div class="workboard-detail">
          <header class="workboard-detail__header">
            <div>
              <span class="workboard-card__priority">${formatPriorityLabel(card.priority)}</span>
              <h2 id=${workboardCardDetailTitleId}>
                <span class="sr-only">${t("workboard.detailTitle")}: </span>${card.title}
              </h2>
            </div>
            <span title=${t("common.cancel")}>
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
            </span>
          </header>
          ${renderWorkboardError(state.error)}

          <section class="workboard-detail__section">
            <div class="workboard-card__lifecycle">
              <span class="workboard-lifecycle workboard-lifecycle--${formatted.tone}">
                ${formatted.label}
              </span>
              <span id=${workboardCardDetailDescriptionId} class="workboard-card__lifecycle-detail">
                ${
                  task && taskIsAuthoritative
                    ? taskDetail(task)
                    : (lifecycle.session?.displayName ?? formatted.detail)
                }
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

          ${
            card.notes
              ? html`
                  <section class="workboard-detail__section">
                    <h3>${t("workboard.fieldNotes")}</h3>
                    <p>${card.notes}</p>
                  </section>
                `
              : nothing
          }
          ${
            sessionTarget
              ? renderDashboard({
                  session: sessionTarget,
                  canMutate: props.canWrite !== false,
                  canGrant: props.canGrant === true,
                })
              : nothing
          }
          ${renderDependencyDetailList(dependencies)}
          ${renderAttachmentDetails(props, card, attachments, writable)}
          ${detailSections.map(([title, values]) => renderDetailList(title, values))}

          <section class="workboard-detail__section">
            <h3>${t("workboard.detailOperatorNotes")}</h3>
            ${
              comments.length
                ? html`
                    <ol class="workboard-detail__list">
                      ${comments.slice(-6).map((comment) => html`<li>${comment.body}</li>`)}
                    </ol>
                  `
                : html`<p>${t("workboard.detailNoNotes")}</p>`
            }
            ${
              writable
                ? html`
                    <textarea
                      class="input workboard-detail__note"
                      maxlength="2000"
                      placeholder=${t("workboard.detailNotePlaceholder")}
                      .value=${state.detailCommentBody}
                      @input=${(event: InputEvent) => {
                        state.detailCommentBody = (
                          event.currentTarget as HTMLTextAreaElement
                        ).value;
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
                : nothing
            }
          </section>

          <div class="workboard-detail__actions">
            ${writable && !archived ? renderEditCardAction(props, card) : nothing}
            ${writable ? renderArchiveCardAction(props, card, busy, archived) : nothing}
            ${
              writable && !archived
                ? renderCardMoveControl(props, card, busy, { wide: true })
                : nothing
            }
            ${
              writable && (linkedSessionKey ? live : activeTask)
                ? renderStopCardAction(props, card, busy)
                : nothing
            }
            ${renderOpenSessionCardAction(props, sessionTarget)}
            ${writable ? renderDeleteCardAction(props, card, busy) : nothing}
            ${showStartControls ? renderStartExecutionControls(props, card) : nothing}
          </div>
        </div>
      </aside>
    `,
  );
}
