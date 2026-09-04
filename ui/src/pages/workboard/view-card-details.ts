import { html, nothing } from "lit";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import {
  addWorkboardCardComment,
  getWorkboardDependencyState,
  getWorkboardLifecycle,
  getWorkboardState,
  type WorkboardCard,
  type WorkboardDependencyState,
  type WorkboardLink,
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

function safeExternalHref(raw: string | undefined): string | null {
  return raw ? resolveSafeExternalUrl(raw, window.location.href) : null;
}

function renderWorkCompleted(card: WorkboardCard) {
  const summary = card.metadata?.automation?.summary?.trim();
  if (!summary) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section workboard-detail__section--summary">
      <h3>${t("workboard.detailWorkCompleted")}</h3>
      <p>${formatUiExternalText(summary)}</p>
    </section>
  `;
}

function renderAttemptSummary(card: WorkboardCard) {
  const summary = card.metadata?.automation?.attemptSummary?.trim();
  if (!summary) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${t("workboard.detailThisAttempt")}</h3>
      <p>${formatUiExternalText(summary)}</p>
    </section>
  `;
}

function renderProgressDetail(card: WorkboardCard) {
  const attempt = card.metadata?.attempts?.at(-1);
  const workerProtocol = card.metadata?.workerProtocol;
  const workerLog = card.metadata?.workerLogs?.at(-1);
  const workspace = card.metadata?.automation?.workspace;
  const values = [
    card.execution
      ? t("workboard.detailExecutionProgress", {
          status: card.execution.status,
          mode: card.execution.mode,
        })
      : "",
    attempt
      ? attempt.model
        ? t("workboard.detailAttemptProgress", {
            status: attempt.status,
            model: attempt.model,
          })
        : t("workboard.detailAttemptProgressNoModel", { status: attempt.status })
      : "",
    workerProtocol?.detail ? formatUiExternalText(workerProtocol.detail) : "",
    workerLog?.message ? formatUiExternalText(workerLog.message) : "",
    workspace?.branch ? t("workboard.detailBranch", { branch: workspace.branch }) : "",
  ].filter(Boolean);
  return renderDetailList(t("workboard.detailProgress"), values);
}

function renderVerificationDetail(card: WorkboardCard) {
  const proof = card.metadata?.proof ?? [];
  const artifacts = card.metadata?.artifacts ?? [];
  const attemptProofIds = new Set(card.metadata?.automation?.attemptProofIds ?? []);
  const attemptProof = proof.filter((entry) => attemptProofIds.has(entry.id));
  const overallProof = proof.filter((entry) => !attemptProofIds.has(entry.id));
  if (proof.length === 0 && artifacts.length === 0) {
    return card.status === "review"
      ? html`
          <section class="workboard-detail__section">
            <h3>${t("workboard.detailVerification")}</h3>
            <div class="workboard-detail__empty-warning">
              ${t("workboard.detailNoVerification")}
            </div>
          </section>
        `
      : nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${t("workboard.detailVerification")}</h3>
      <ul class="workboard-detail__list workboard-detail__verification">
        ${
          attemptProof.length
            ? html`<li><strong>${t("workboard.detailVerifiedThisAttempt")}</strong></li>`
            : nothing
        }
        ${[...attemptProof.slice(-8), ...overallProof.slice(-8)].map((entry, index) => {
          const href = safeExternalHref(entry.url);
          return html`
            ${
              index === attemptProof.slice(-8).length && attemptProof.length && overallProof.length
                ? html`<li><strong>${t("workboard.detailOverallEvidence")}</strong></li>`
                : nothing
            }
            <li>
              <span
                class="workboard-detail__proof-status workboard-detail__proof-status--${entry.status}"
              >
                ${entry.status}
              </span>
              <div>
                <strong>${entry.label ?? entry.command ?? t("workboard.detailProof")}</strong>
                ${entry.note ? html`<p>${formatUiExternalText(entry.note)}</p>` : nothing}
                ${
                  href
                    ? html`<a href=${href} target="_blank" rel="noopener noreferrer"
                        >${entry.url}</a
                      >`
                    : nothing
                }
              </div>
            </li>
          `;
        })}
        ${artifacts.slice(-8).map((artifact) => {
          const href = safeExternalHref(artifact.url);
          return html`
            <li>
              <span class="workboard-detail__proof-status">${t("workboard.detailArtifact")}</span>
              <div>
                <strong>${artifact.label ?? artifact.path ?? artifact.url}</strong>
                ${
                  href
                    ? html`<a href=${href} target="_blank" rel="noopener noreferrer"
                        >${artifact.url}</a
                      >`
                    : nothing
                }
              </div>
            </li>
          `;
        })}
      </ul>
    </section>
  `;
}

function formatRelatedWorkType(type: string): string {
  const labels: Record<string, string> = {
    parent: t("workboard.linkType.parent"),
    child: t("workboard.linkType.child"),
    blocks: t("workboard.linkType.blocks"),
    blocked_by: t("workboard.linkType.blockedBy"),
    relates_to: t("workboard.linkType.relatesTo"),
    source: t("workboard.linkType.source"),
  };
  return labels[type] ?? type;
}

function renderRelatedWork(card: WorkboardCard, cards: readonly WorkboardCard[]) {
  type RelatedWorkLink = WorkboardLink | (Omit<WorkboardLink, "type"> & { type: "source" });
  const sourceLink: RelatedWorkLink | undefined = card.sourceUrl
    ? { id: "source", type: "source", url: card.sourceUrl, createdAt: card.createdAt }
    : undefined;
  const links: RelatedWorkLink[] = [
    ...(sourceLink ? [sourceLink] : []),
    ...(card.metadata?.links ?? []),
  ];
  if (links.length === 0) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${t("workboard.detailRelatedWork")}</h3>
      <ul class="workboard-detail__list workboard-detail__related">
        ${links.slice(-10).map((entry) => {
          const href = safeExternalHref(entry.url);
          const targetTitle = entry.targetCardId
            ? cards.find((candidate) => candidate.id === entry.targetCardId)?.title
            : undefined;
          const label = targetTitle ?? entry.title ?? entry.targetCardId ?? entry.url ?? entry.type;
          return html`
            <li>
              <span>${formatRelatedWorkType(entry.type)}</span>
              ${
                href
                  ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${label}</a>`
                  : html`<strong>${label}</strong>`
              }
            </li>
          `;
        })}
      </ul>
    </section>
  `;
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
  const attachments = card.metadata?.attachments ?? [];
  const diagnostics = card.metadata?.diagnostics ?? [];
  const workerLogs = card.metadata?.workerLogs ?? [];
  const workerProtocol = card.metadata?.workerProtocol;
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
      t("workboard.badgeAttachments", { count: String(attachments.length) }),
      detailValues(attachments, "fileName", "mimeType", "note"),
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
      t("workboard.eventsLabel"),
      events.map((event) => `${formatEventLabel(event)} ${formatUpdatedTime(event.at)}`),
    ],
  ];
  return html`
    <openclaw-modal-dialog
      class="drawer"
      label=${card.title}
      description=${
        task && taskIsAuthoritative
          ? taskDetail(task)
          : (lifecycle.session?.displayName ?? formatted.detail)
      }
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
                <span class="sr-only">${t("workboard.detailTitle")}: </span>${card.title}
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
          ${renderWorkCompleted(card)} ${renderAttemptSummary(card)} ${renderProgressDetail(card)}
          ${renderVerificationDetail(card)} ${renderRelatedWork(card, state.cards)}
          ${
            linkedSessionKey
              ? html`
                  <openclaw-workboard-card-dashboard
                    .session=${{
                      sessionKey: linkedSessionKey,
                      agentId: parseAgentSessionKey(linkedSessionKey)?.agentId ?? card.agentId,
                    }}
                    .client=${props.client}
                    .connected=${props.connected}
                    .canMutate=${props.canWrite !== false}
                    .canGrant=${props.canGrant === true}
                  ></openclaw-workboard-card-dashboard>
                `
              : nothing
          }
          ${renderDependencyDetailList(dependencies)}
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
            ${renderOpenSessionCardAction(props, linkedSessionKey)}
            ${writable ? renderDeleteCardAction(props, card, busy) : nothing}
            ${showStartControls ? renderStartExecutionControls(props, card) : nothing}
          </div>
        </div>
      </aside>
    </openclaw-modal-dialog>
  `;
}
