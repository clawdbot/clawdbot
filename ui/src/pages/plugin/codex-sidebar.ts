import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import {
  getClaudeSessionsState,
  loadClaudeSessions,
  stopClaudeSessionsPolling,
} from "./claude-sessions-controller.ts";
import {
  getCodexSessionsState,
  loadCodexSessions,
  stopCodexSessionsPolling,
  type CodexSessionPayload,
} from "./codex-sessions-controller.ts";
import { pluginTabSearch } from "./route.ts";

const SIDEBAR_REFRESH_INTERVAL_MS = 30_000;
/* The sidebar is a quick-jump list: it renders only the newest sessions per
   host. The full catalog stays on the sessions page behind "View all". */
const SIDEBAR_SESSIONS_PER_HOST = 10;

function sessionTitle(session: CodexSessionPayload, catalogKind: "codex" | "claude"): string {
  return (
    session.name?.trim() ||
    t(catalogKind === "claude" ? "claudeSessions.untitled" : "codexSessions.untitled")
  );
}

function sessionTimestamp(session: CodexSessionPayload): string {
  const value = session.recencyAt ?? session.updatedAt;
  if (!value || !Number.isFinite(value)) {
    return "";
  }
  return formatRelativeTimestamp(value < 1_000_000_000_000 ? value * 1_000 : value);
}

export class CodexSidebar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) catalogKind: "codex" | "claude" = "codex";
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) selectedHostId = "";
  @property({ attribute: false }) selectedThreadId = "";
  @property({ attribute: false }) onOpenSession?: (hostId: string, threadId: string) => void;
  @property({ attribute: false }) onViewAll?: () => void;
  @state() private revision = 0;

  private readonly controllerHost = {};
  private loadedClient: GatewayBrowserClient | null = null;
  private hydrationToken: object | null = null;
  private refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  override disconnectedCallback() {
    this.hydrationToken = null;
    this.clearRefreshTimer();
    this.stopPolling();
    super.disconnectedCallback();
  }

  override willUpdate() {
    const sessionsState = this.sessionsState();
    sessionsState.requestUpdate = () => {
      this.revision += 1;
    };
    if (!this.connected || !this.client) {
      if (this.loadedClient) {
        this.loadedClient = null;
        this.hydrationToken = null;
        this.clearRefreshTimer();
        this.stopPolling();
      }
      return;
    }
    if (this.connected && this.client && this.loadedClient !== this.client) {
      if (this.loadedClient) {
        this.hydrationToken = null;
        this.clearRefreshTimer();
        this.stopPolling();
        sessionsState.requestUpdate = () => {
          this.revision += 1;
        };
      }
      this.loadedClient = this.client;
      this.beginRefresh();
    }
  }

  private sessionsState() {
    return this.catalogKind === "claude"
      ? getClaudeSessionsState(this.controllerHost)
      : getCodexSessionsState(this.controllerHost);
  }

  private stopPolling(): void {
    if (this.catalogKind === "claude") {
      stopClaudeSessionsPolling(this.controllerHost);
    } else {
      stopCodexSessionsPolling(this.controllerHost);
    }
  }

  private async loadSessions(): Promise<void> {
    const catalogState = this.sessionsState();
    if (this.catalogKind === "claude") {
      await loadClaudeSessions(catalogState, this.client);
    } else {
      await loadCodexSessions(catalogState, this.client);
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      globalThis.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private beginRefresh(): void {
    this.clearRefreshTimer();
    // Token guards the refresh chain across client switches: a stale load must
    // not schedule a second timer next to the replacement client's chain.
    const token = {};
    this.hydrationToken = token;
    void this.loadSessions().finally(() => {
      if (this.hydrationToken !== token || !this.loadedClient) {
        return;
      }
      this.refreshTimer = globalThis.setTimeout(
        () => this.beginRefresh(),
        SIDEBAR_REFRESH_INTERVAL_MS,
      );
    });
  }

  private sessionSearch(hostId: string, threadId: string): string {
    return pluginTabSearch({
      pluginId: this.catalogKind === "claude" ? "anthropic" : "codex",
      id: "sessions",
      hostId,
      threadId,
    });
  }

  override render() {
    void this.revision;
    const sessionsState = this.sessionsState();
    const hosts = sessionsState.hosts.filter((host) => host.sessions.length > 0);
    if (!this.connected || (sessionsState.error && hosts.length === 0)) {
      return nothing;
    }
    return html`
      <section
        class="sidebar-codex-sessions"
        aria-label=${this.catalogKind === "claude"
          ? t("claudeSessions.sidebar.title")
          : t("codexSessions.sidebar.title")}
      >
        <div class="sidebar-recent-sessions__head sidebar-recent-sessions__head--root">
          <span class="sidebar-recent-sessions__label-text"
            >${this.catalogKind === "claude"
              ? t("claudeSessions.sidebar.title")
              : t("codexSessions.sidebar.title")}</span
          >
          <button
            type="button"
            class="sidebar-session-sort"
            title=${this.catalogKind === "claude"
              ? t("claudeSessions.sidebar.viewAll")
              : t("codexSessions.sidebar.viewAll")}
            aria-label=${this.catalogKind === "claude"
              ? t("claudeSessions.sidebar.viewAll")
              : t("codexSessions.sidebar.viewAll")}
            @click=${() => this.onViewAll?.()}
          >
            ${icons.terminal}
          </button>
        </div>
        ${hosts.map((host) => {
          const sessions = host.sessions.slice(0, SIDEBAR_SESSIONS_PER_HOST);
          const truncated = Boolean(host.nextCursor) || host.sessions.length > sessions.length;
          return html`
            <div class="sidebar-recent-sessions__group" data-codex-host-id=${host.hostId}>
              <div class="sidebar-recent-sessions__head">
                <span class="sidebar-recent-sessions__label-text">${host.label}</span>
                <span class="sidebar-session-group-count">${host.sessions.length}</span>
              </div>
              <div class="sidebar-recent-sessions__list">
                ${sessions.map((session) => {
                  const active =
                    this.selectedHostId === host.hostId &&
                    this.selectedThreadId === session.threadId;
                  const search = this.sessionSearch(host.hostId, session.threadId);
                  return html`
                    <a
                      href=${`${this.basePath}/plugin${search}`}
                      class="sidebar-recent-session ${active
                        ? "sidebar-recent-session--active"
                        : ""}"
                      data-codex-thread-id=${session.threadId}
                      title=${sessionTitle(session, this.catalogKind)}
                      @click=${(event: MouseEvent) => {
                        if (
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey
                        ) {
                          return;
                        }
                        event.preventDefault();
                        this.onOpenSession?.(host.hostId, session.threadId);
                      }}
                    >
                      <span class="sidebar-recent-session__text">
                        <span class="sidebar-recent-session__name"
                          >${sessionTitle(session, this.catalogKind)}</span
                        >
                      </span>
                      <span class="session-row-trail">${sessionTimestamp(session)}</span>
                    </a>
                  `;
                })}
              </div>
              ${truncated
                ? html`<div class="sidebar-codex-sessions__truncated">
                    ${this.catalogKind === "claude"
                      ? t("claudeSessions.sidebar.truncated")
                      : t("codexSessions.sidebar.truncated")}
                  </div>`
                : nothing}
            </div>
          `;
        })}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-codex-sidebar")) {
  customElements.define("openclaw-codex-sidebar", CodexSidebar);
}
