// Control UI view for read-only Codex sessions federated through the Gateway.
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../../lib/format.ts";
import {
  configureCodexSessionsPolling,
  getCodexSessionsState,
  loadCodexSessions,
  loadMoreCodexSessions,
  setCodexSessionsArchived,
  setCodexSessionsSearch,
  type CodexSessionHostPayload,
  type CodexSessionPayload,
  type CodexSessionsUiState,
} from "./codex-sessions-controller.ts";

type CodexSessionsProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate?: () => void;
};

function timestampMs(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  // Codex app-server timestamps are Unix seconds. Keep millisecond payloads
  // forward-compatible so the UI does not turn them into far-future dates.
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function displayTitle(session: CodexSessionPayload): string {
  const name = session.name?.trim();
  return name || t("codexSessions.untitled");
}

function displayStatus(session: CodexSessionPayload): string {
  if (session.archived) {
    return t("codexSessions.status.archived");
  }
  switch (session.status) {
    case "active":
      return t("codexSessions.status.active");
    case "idle":
      return t("codexSessions.status.idle");
    case "notLoaded":
      return t("codexSessions.status.notLoaded");
    case "systemError":
      return t("codexSessions.status.systemError");
    default:
      return session.status || t("codexSessions.status.unknown");
  }
}

function statusClass(session: CodexSessionPayload): string {
  if (session.archived) {
    return "codex-session__status--archived";
  }
  if (session.status === "systemError") {
    return "codex-session__status--error";
  }
  return session.status === "active"
    ? "codex-session__status--active"
    : "codex-session__status--idle";
}

function renderThreadMeta(session: CodexSessionPayload): TemplateResult {
  const updatedAt = timestampMs(session.recencyAt ?? session.updatedAt);
  const createdAt = timestampMs(session.createdAt);
  const updatedLabel = updatedAt ? formatRelativeTimestamp(updatedAt) : t("common.na");
  return html`
    <div class="codex-session__meta">
      ${session.cwd
        ? html`<span class="codex-session__cwd" title=${session.cwd}>
            ${icons.folder}<span>${session.cwd}</span>
          </span>`
        : nothing}
      ${session.gitBranch
        ? html`<span class="codex-session__tag codex-session__tag--branch">
            ${session.gitBranch}
          </span>`
        : nothing}
      ${session.source ? html`<span class="codex-session__tag">${session.source}</span>` : nothing}
      ${session.modelProvider
        ? html`<span class="codex-session__tag">${session.modelProvider}</span>`
        : nothing}
      <span
        class="codex-session__updated"
        title=${updatedAt
          ? formatDateTimeMs(updatedAt)
          : createdAt
            ? formatDateTimeMs(createdAt)
            : ""}
      >
        ${icons.clock}${updatedLabel}
      </span>
    </div>
  `;
}

function renderSession(session: CodexSessionPayload): TemplateResult {
  return html`
    <article class="codex-session" data-thread-id=${session.threadId}>
      <div class="codex-session__glyph" aria-hidden="true">${icons.terminal}</div>
      <div class="codex-session__body">
        <div class="codex-session__heading">
          <h3 class="codex-session__title">${displayTitle(session)}</h3>
          <span class="codex-session__status ${statusClass(session)}">
            <span class="codex-session__status-dot" aria-hidden="true"></span>
            ${displayStatus(session)}
          </span>
        </div>
        ${renderThreadMeta(session)}
        <div class="codex-session__identity" title=${session.threadId}>
          ${t("codexSessions.threadId")} <span>${session.threadId}</span>
        </div>
      </div>
    </article>
  `;
}

function renderHost(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  host: CodexSessionHostPayload,
  interactionsEnabled: boolean,
): TemplateResult {
  const loadingMore = state.loadingMoreHostIds.has(host.hostId);
  const statusLabel = host.connected
    ? t("codexSessions.host.connected")
    : t("codexSessions.host.offline");
  return html`
    <section
      class="codex-host ${host.error ? "codex-host--error" : ""}"
      data-host-id=${host.hostId}
    >
      <header class="codex-host__header">
        <div class="codex-host__icon" aria-hidden="true">${icons.monitor}</div>
        <div class="codex-host__identity">
          <div class="codex-host__title-row">
            <h2 class="codex-host__title">${host.label}</h2>
            <span class="codex-host__kind">
              ${host.kind === "gateway"
                ? t("codexSessions.host.gateway")
                : t("codexSessions.host.node")}
            </span>
          </div>
          <div class="codex-host__status ${host.connected ? "codex-host__status--online" : ""}">
            <span class="codex-host__status-dot" aria-hidden="true"></span>
            ${statusLabel}
            <span aria-hidden="true">·</span>
            ${t("codexSessions.host.sessionCount", { count: String(host.sessions.length) })}
          </div>
        </div>
        ${host.nodeId || host.endpointId
          ? html`<div class="codex-host__id" title=${host.nodeId ?? host.endpointId ?? ""}>
              ${host.nodeId ?? host.endpointId}
            </div>`
          : nothing}
      </header>
      ${host.error
        ? html`
            <div class="codex-host__error" role="status">
              ${icons.alertTriangle}
              <div>
                <strong>${t("codexSessions.host.unavailable")}</strong>
                <span>${host.error.message}</span>
              </div>
            </div>
          `
        : nothing}
      ${host.sessions.length > 0
        ? html`<div class="codex-host__sessions">${host.sessions.map(renderSession)}</div>`
        : !host.error
          ? html`<div class="codex-host__empty">
              ${state.search.trim()
                ? t("codexSessions.empty.search")
                : state.archived
                  ? t("codexSessions.empty.archived")
                  : t("codexSessions.empty.active")}
            </div>`
          : nothing}
      ${host.nextCursor
        ? html`<div class="codex-host__footer">
            <button
              class="btn btn--small"
              type="button"
              ?disabled=${loadingMore || !interactionsEnabled || !host.connected}
              @click=${() => void loadMoreCodexSessions(state, client, host.hostId)}
            >
              ${loadingMore ? t("codexSessions.loadingMore") : t("codexSessions.loadMore")}
            </button>
          </div>`
        : nothing}
    </section>
  `;
}

export function renderCodexSessions(props: CodexSessionsProps) {
  const state = getCodexSessionsState(props.host);
  state.requestUpdate = props.onRequestUpdate ?? null;
  configureCodexSessionsPolling(state, props.client, props.connected);
  if (props.connected && !state.loading && !state.refreshedAtMs && !state.error) {
    void loadCodexSessions(state, props.client);
  }

  const hostErrors = state.hosts.filter((host) => host.error).length;
  const onlineHosts = state.hosts.filter((host) => host.connected).length;
  const sessionCount = state.hosts.reduce((count, host) => count + host.sessions.length, 0);
  return html`
    <section class="codex-sessions">
      <header class="codex-sessions__hero">
        <div>
          <div class="codex-sessions__eyebrow">${t("codexSessions.eyebrow")}</div>
          <h1 class="codex-sessions__title">${t("codexSessions.title")}</h1>
          <p class="codex-sessions__subtitle">${t("codexSessions.subtitle")}</p>
        </div>
        <div class="codex-sessions__summary" aria-label=${t("codexSessions.summaryLabel")}>
          <div>
            <strong>${sessionCount}</strong><span>${t("codexSessions.summary.sessions")}</span>
          </div>
          <div>
            <strong>${onlineHosts}</strong><span>${t("codexSessions.summary.onlineHosts")}</span>
          </div>
          <div>
            <strong>${state.hosts.length}</strong><span>${t("codexSessions.summary.hosts")}</span>
          </div>
        </div>
      </header>

      <div class="codex-sessions__toolbar">
        <label class="codex-sessions__search">
          <span aria-hidden="true">${icons.search}</span>
          <input
            type="search"
            aria-label=${t("codexSessions.searchLabel")}
            placeholder=${t("codexSessions.searchPlaceholder")}
            ?disabled=${!props.connected}
            .value=${state.search}
            @input=${(event: Event) =>
              setCodexSessionsSearch(
                state,
                props.client,
                (event.currentTarget as HTMLInputElement).value,
              )}
          />
        </label>
        <div class="codex-sessions__scope" role="group" aria-label=${t("codexSessions.scopeLabel")}>
          <button
            class=${state.archived ? "" : "codex-sessions__scope--active"}
            type="button"
            aria-pressed=${String(!state.archived)}
            ?disabled=${!props.connected}
            @click=${() => setCodexSessionsArchived(state, props.client, false)}
          >
            ${t("codexSessions.scope.active")}
          </button>
          <button
            class=${state.archived ? "codex-sessions__scope--active" : ""}
            type="button"
            aria-pressed=${String(state.archived)}
            ?disabled=${!props.connected}
            @click=${() => setCodexSessionsArchived(state, props.client, true)}
          >
            ${icons.archive}${t("codexSessions.scope.archived")}
          </button>
        </div>
        <button
          class="btn btn--small codex-sessions__refresh"
          type="button"
          aria-label=${t("codexSessions.refresh")}
          ?disabled=${state.loading || !props.connected}
          @click=${() => void loadCodexSessions(state, props.client)}
        >
          ${icons.refresh}<span>${t("codexSessions.refresh")}</span>
        </button>
      </div>

      ${!props.connected
        ? html`<div class="callout danger" role="alert">${t("codexSessions.disconnected")}</div>`
        : nothing}
      ${state.error ? html`<div class="callout danger" role="alert">${state.error}</div>` : nothing}
      ${hostErrors > 0
        ? html`<div class="codex-sessions__partial" role="status">
            ${icons.alertTriangle}${t("codexSessions.partial", {
              count: String(hostErrors),
            })}
          </div>`
        : nothing}

      <div class="codex-sessions__results" aria-live="polite">
        ${state.loading && state.hosts.length === 0
          ? html`<div class="codex-sessions__loading">
              <span class="codex-sessions__spinner" aria-hidden="true"></span>
              ${t("codexSessions.loading")}
            </div>`
          : state.hosts.length === 0 && !state.error && props.connected
            ? html`<div class="codex-sessions__empty">
                <div class="codex-sessions__empty-icon" aria-hidden="true">${icons.terminal}</div>
                <h2>${t("codexSessions.empty.title")}</h2>
                <p>${t("codexSessions.empty.subtitle")}</p>
              </div>`
            : state.hosts.map((host) => renderHost(state, props.client, host, props.connected))}
      </div>
    </section>
  `;
}
