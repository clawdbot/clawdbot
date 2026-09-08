import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import { renderPanelLoadingSkeleton } from "../panel-loading-skeleton.ts";
import type { TerminalSessionInfo } from "./terminal-connection.ts";

type TerminalSessionPickerProps = {
  open: boolean;
  loading: boolean;
  sessions: TerminalSessionInfo[];
  currentSessionIds: ReadonlySet<string>;
  onToggle: () => void;
  onDismiss: (restoreFocus: boolean) => void;
  onFocusOut: (event: FocusEvent) => void;
  onRefresh: () => void;
  onAttach: (sessionId: string, owner: TerminalSessionInfo["owner"]) => void;
};

const TERMINAL_SESSION_PICKER_ID = "terminal-session-picker-dialog";

export function renderTerminalSessionPicker(props: TerminalSessionPickerProps) {
  return html`
    <div class="tp-session-picker" @focusout=${props.onFocusOut}>
      <button
        class="rail-header__action tp-icon"
        type="button"
        title=${t("terminal.sessions")}
        aria-label=${t("terminal.sessions")}
        aria-expanded=${props.open ? "true" : "false"}
        aria-haspopup="dialog"
        aria-controls=${TERMINAL_SESSION_PICKER_ID}
        @click=${props.onToggle}
      >
        ${icons.server}
      </button>
      ${
        props.open
          ? html`<div
              id=${TERMINAL_SESSION_PICKER_ID}
              class="tp-session-menu"
              role="dialog"
              aria-label=${t("terminal.sessions")}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key !== "Escape") {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                props.onDismiss(true);
              }}
            >
              <div class="tp-session-menu__header">
                <span>${t("terminal.sessions")}</span>
                <button class="tp-session-refresh" type="button" @click=${props.onRefresh}>
                  ${t("terminal.refreshSessions")}
                </button>
              </div>
              ${
                props.loading
                  ? renderPanelLoadingSkeleton("terminal", t("terminal.loadingSessions"), true)
                  : props.sessions.length === 0
                    ? html`<div class="tp-session-empty">${t("terminal.noSessions")}</div>`
                    : props.sessions.map((session) => {
                        const current = props.currentSessionIds.has(session.sessionId);
                        const agentOwned = session.owner?.startsWith("agent:") === true;
                        const state = `${agentOwned ? `${t("terminal.agentOwnedBadge")} · ` : ""}${
                          current
                            ? t("terminal.currentSession")
                            : session.attached
                              ? t("terminal.sessionAttached")
                              : t("terminal.detached")
                        }`;
                        return html`<button
                          class="tp-session"
                          type="button"
                          ?disabled=${current}
                          title=${current ? state : t("terminal.attachSession")}
                          @click=${() => props.onAttach(session.sessionId, session.owner)}
                        >
                          <span class="tp-session__agent">${session.agentId}</span>
                          <span class="tp-session__cwd">${session.cwd}</span>
                          <span class="tp-session__state">${state}</span>
                        </button>`;
                      })
              }
            </div>`
          : nothing
      }
    </div>
  `;
}
