import { html, nothing } from "lit";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  visibleWorkspaceConflictPaths,
  workspaceConflictCount,
  workspaceConflictGitCommands,
  workspaceConflictPathForDisplay,
  type WorkspaceResultConflict,
} from "../workspace-conflict.ts";

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
    <div class="callout warn callout--dismissible chat-workspace-conflict-notice" role="status">
      <div class="callout__content chat-workspace-conflict-notice__content">
        <div class="chat-workspace-conflict-notice__title">
          <span aria-hidden="true">${icons.alertTriangle}</span>
          <strong>${title}</strong>
        </div>
        <p>${t("chat.workspaceConflict.description")}</p>
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
      </div>
      ${props.onDismiss
        ? html`
            <openclaw-tooltip .content=${t("chat.workspaceConflict.dismiss")}>
              <button
                class="callout__dismiss"
                type="button"
                @click=${props.onDismiss}
                aria-label=${t("chat.workspaceConflict.dismiss")}
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>
          `
        : nothing}
    </div>
  `;
}
