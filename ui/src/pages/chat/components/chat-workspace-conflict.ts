import { html, nothing } from "lit";
import { handleCopyButton, renderCopyButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  visibleWorkspaceConflictPaths,
  workspaceConflictCount,
  workspaceConflictGitCommands,
  workspaceConflictPathForDisplay,
  type WorkspaceResultConflict,
} from "../workspace-conflict.ts";

function renderConflictCopyAction(text: string, label: string) {
  return html`<button
    class="btn btn--sm chat-copy-btn"
    type="button"
    @click=${(event: Event) => void handleCopyButton(event, text, label)}
  >
    <span data-copy-label>${label}</span>
  </button>`;
}

export function renderWorkspaceConflictNotice(props: {
  conflict?: WorkspaceResultConflict;
  onDismiss?: () => void;
}) {
  const conflict = props.conflict;
  if (!conflict) {
    return nothing;
  }
  const count = workspaceConflictCount(conflict);
  const visible = visibleWorkspaceConflictPaths(conflict);
  const commands = workspaceConflictGitCommands(conflict);
  const title = t(
    count === 1 ? "chat.workspaceConflict.titleOne" : "chat.workspaceConflict.titleMany",
    { count: String(count) },
  );
  return html`
    <details
      class="chat-composer-neighbor-card chat-composer-neighbor-card--warn chat-workspace-conflict-notice"
      role="status"
    >
      <summary class="chat-workspace-conflict-notice__summary">
        <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
          >${icons.alertTriangle}</span
        >
        <span class="chat-composer-neighbor-card__copy">
          <strong>${title}</strong>
          <span>${t("chat.workspaceConflict.summary")}</span>
        </span>
        <span class="chat-workspace-conflict-notice__chevron" aria-hidden="true"
          >${icons.chevronUp}</span
        >
        ${props.onDismiss
          ? html`<button
              class="chat-error__dismiss"
              type="button"
              @click=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onDismiss?.();
              }}
              aria-label=${t("chat.workspaceConflict.dismiss")}
            >
              ${icons.x}
            </button>`
          : nothing}
      </summary>
      <div class="chat-workspace-conflict-notice__content">
        <ul class="chat-workspace-conflict-paths">
          ${visible.paths.map((entryPath) => {
            const entryCommands = workspaceConflictGitCommands(conflict, entryPath);
            return html`<li>
              <code>${workspaceConflictPathForDisplay(entryPath)}</code>
              ${entryCommands
                ? html`<span class="chat-workspace-conflict-path-actions">
                    ${renderConflictCopyAction(
                      entryCommands.inspect,
                      t("chat.workspaceConflict.inspectCloud"),
                    )}
                    ${renderConflictCopyAction(
                      entryCommands.takeCloud,
                      t("chat.workspaceConflict.takeCloud"),
                    )}
                  </span>`
                : nothing}
            </li>`;
          })}
        </ul>
        ${visible.remaining > 0
          ? html`<div class="chat-workspace-conflict-more">
              ${t("chat.workspaceConflict.morePaths", { count: String(visible.remaining) })}
            </div>`
          : nothing}
        <details class="chat-workspace-conflict-commands-disclosure">
          <summary>${t("chat.workspaceConflict.showCommands")}</summary>
          <div class="chat-workspace-conflict-ref">
            <span>${t("chat.workspaceConflict.stagedResult")}</span>
            <code>${conflict.stagedResultRef}</code>
            ${renderCopyButton(
              conflict.stagedResultRef,
              t("chat.workspaceConflict.copyStagedResult"),
            )}
          </div>
          ${commands
            ? html`<div class="chat-workspace-conflict-commands">
                  <div>
                    <span>${t("chat.workspaceConflict.inspectCloud")}</span>
                    <code>${commands.inspect}</code>
                    ${renderCopyButton(
                      commands.inspect,
                      t("chat.workspaceConflict.copyInspectCommand"),
                    )}
                  </div>
                  <div>
                    <span>${t("chat.workspaceConflict.takeCloud")}</span>
                    <code>${commands.takeCloud}</code>
                    ${renderCopyButton(
                      commands.takeCloud,
                      t("chat.workspaceConflict.copyTakeCommand"),
                    )}
                  </div>
                </div>
                <p class="chat-workspace-conflict-command-help">
                  ${t("chat.workspaceConflict.commandHelp")}
                </p>`
            : html`<p class="chat-workspace-conflict-command-help">
                ${t("chat.workspaceConflict.commandsUnavailable")}
              </p>`}
        </details>
      </div>
    </details>
  `;
}

export function renderWorkspaceConflictTranscriptMessage(
  conflict: WorkspaceResultConflict,
  messageKey: string,
  entryId?: string,
) {
  const count = workspaceConflictCount(conflict);
  const visible = visibleWorkspaceConflictPaths(conflict);
  return html`
    <div
      class="chat-bubble chat-bubble--workspace-conflict"
      data-message-id=${messageKey}
      data-entry-id=${entryId || nothing}
    >
      <div class="chat-workspace-conflict-event" role="status">
        <div class="chat-workspace-conflict-event__header">
          <span aria-hidden="true">${icons.alertTriangle}</span>
          <strong
            >${t(
              count === 1
                ? "chat.workspaceConflict.eventTitleOne"
                : "chat.workspaceConflict.eventTitleMany",
              { count: String(count) },
            )}</strong
          >
        </div>
        <p>${t("chat.workspaceConflict.eventDescription")}</p>
        <ul class="chat-workspace-conflict-paths">
          ${visible.paths.map(
            (entryPath) =>
              html`<li><code>${workspaceConflictPathForDisplay(entryPath)}</code></li>`,
          )}
        </ul>
        ${visible.remaining > 0
          ? html`<div class="chat-workspace-conflict-more">
              ${t("chat.workspaceConflict.morePaths", { count: String(visible.remaining) })}
            </div>`
          : nothing}
        <div class="chat-workspace-conflict-ref">
          <span>${t("chat.workspaceConflict.stagedResult")}</span>
          <code>${conflict.stagedResultRef}</code>
        </div>
      </div>
    </div>
  `;
}
