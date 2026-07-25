import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { renderWorkspaceConflictNotice } from "./components/chat-workspace-conflict.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";

type ChatViewNoticesProps = {
  error?: string | null;
  focusMode?: boolean;
  onDismissError?: () => void;
  onDismissWorkspaceConflict?: () => void;
  onToggleFocusMode?: () => void;
  workspaceConflict?: WorkspaceResultConflict | null;
};

export function renderChatViewNotices(props: ChatViewNoticesProps) {
  return html`
    ${props.error
      ? html`
          <div class="chat-error" role="alert">
            <span class="chat-error__dot" aria-hidden="true"></span>
            <span class="chat-error__content">${props.error}</span>
            ${props.onDismissError
              ? html`
                  <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
                    <button
                      class="chat-error__dismiss"
                      type="button"
                      @click=${props.onDismissError}
                      aria-label=${t("chat.actions.dismissError")}
                    >
                      ${icons.x}
                    </button>
                  </openclaw-tooltip>
                `
              : nothing}
          </div>
        `
      : nothing}
    ${renderWorkspaceConflictNotice({
      conflict: props.workspaceConflict ?? undefined,
      onDismiss: props.onDismissWorkspaceConflict,
    })}
    ${props.focusMode && props.onToggleFocusMode
      ? html`
          <openclaw-tooltip .content=${t("chat.actions.exitFocusMode")}>
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label=${t("chat.actions.exitFocusMode")}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        `
      : nothing}
  `;
}
