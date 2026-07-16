import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { TerminalSessionInfo } from "./terminal-connection.ts";

type TerminalSessionPickerProps = {
  open: boolean;
  loading: boolean;
  sessions: TerminalSessionInfo[];
  currentSessionIds: ReadonlySet<string>;
  onToggle: () => void;
  onRefresh: () => void;
  onAttach: (sessionId: string) => void;
};

export function renderTerminalSessionPicker(props: TerminalSessionPickerProps) {
  return html`
    <div class="tp-session-picker">
      <button
        class="tp-icon"
        type="button"
        title=${t("terminal.sessions")}
        aria-label=${t("terminal.sessions")}
        aria-expanded=${props.open ? "true" : "false"}
        @click=${props.onToggle}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          aria-hidden="true"
        >
          <path d="M3 3.25h10v3.5H3zM3 9.25h10v3.5H3z" />
          <path d="m5 4.5 1 1-1 1m0 4 1 1-1 1" />
        </svg>
      </button>
      ${props.open
        ? html`<div class="tp-session-menu" role="dialog" aria-label=${t("terminal.sessions")}>
            <div class="tp-session-menu__header">
              <span>${t("terminal.sessions")}</span>
              <button class="tp-session-refresh" type="button" @click=${props.onRefresh}>
                ${t("terminal.refreshSessions")}
              </button>
            </div>
            ${props.loading
              ? html`<div class="tp-session-empty">${t("terminal.loadingSessions")}</div>`
              : props.sessions.length === 0
                ? html`<div class="tp-session-empty">${t("terminal.noSessions")}</div>`
                : props.sessions.map((session) => {
                    const current = props.currentSessionIds.has(session.sessionId);
                    const state = current
                      ? t("terminal.currentSession")
                      : session.attached
                        ? t("terminal.sessionAttached")
                        : t("terminal.detached");
                    return html`<button
                      class="tp-session"
                      type="button"
                      ?disabled=${current}
                      title=${current ? state : t("terminal.attachSession")}
                      @click=${() => props.onAttach(session.sessionId)}
                    >
                      <span class="tp-session__agent">${session.agentId}</span>
                      <span class="tp-session__cwd">${session.cwd}</span>
                      <span class="tp-session__state">${state}</span>
                    </button>`;
                  })}
          </div>`
        : nothing}
    </div>
  `;
}
