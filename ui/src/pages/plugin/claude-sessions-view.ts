import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../../lib/format.ts";
import {
  bindClaudeTranscript,
  configureClaudeSessionsPolling,
  getClaudeSessionsState,
  loadClaudeSessions,
  loadClaudeTranscript,
  loadMoreClaudeSessions,
  setClaudeSessionsSearch,
  unbindClaudeTranscript,
} from "./claude-sessions-controller.ts";
import type {
  CodexSessionHostPayload,
  CodexSessionPayload,
  CodexSessionsUiState,
  CodexTranscriptItem,
} from "./codex-sessions-controller.ts";

type ClaudeSessionsProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate?: () => void;
  selectedHostId?: string;
  selectedThreadId?: string;
  onOpenSession?: (hostId: string, threadId: string) => void;
  onCloseSession?: () => void;
};

function timestampMs(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function displayTitle(session: CodexSessionPayload): string {
  return session.name?.trim() || t("claudeSessions.untitled");
}

function renderSessionMeta(session: CodexSessionPayload): TemplateResult {
  const updatedAt = timestampMs(session.recencyAt ?? session.updatedAt);
  const createdAt = timestampMs(session.createdAt);
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
      <span
        class="codex-session__updated"
        title=${updatedAt
          ? formatDateTimeMs(updatedAt)
          : createdAt
            ? formatDateTimeMs(createdAt)
            : ""}
      >
        ${icons.clock}${updatedAt ? formatRelativeTimestamp(updatedAt) : t("common.na")}
      </span>
    </div>
  `;
}

function renderSession(
  host: CodexSessionHostPayload,
  interactionsEnabled: boolean,
  onOpenSession: ClaudeSessionsProps["onOpenSession"],
  session: CodexSessionPayload,
): TemplateResult {
  const title = displayTitle(session);
  return html`
    <article class="codex-session" data-thread-id=${session.threadId} aria-label=${title}>
      <div class="codex-session__glyph" aria-hidden="true">${icons.terminal}</div>
      <div class="codex-session__body">
        <div class="codex-session__heading">
          <h3 class="codex-session__title">${title}</h3>
          <span class="codex-session__status codex-session__status--idle">
            <span class="codex-session__status-dot" aria-hidden="true"></span>
            ${t("claudeSessions.stored")}
          </span>
        </div>
        ${renderSessionMeta(session)}
        <div class="codex-session__identity" title=${session.threadId}>
          ${t("claudeSessions.sessionId")} <span>${session.threadId}</span>
        </div>
      </div>
      <div class="codex-session__actions">
        <button
          class="btn btn--small codex-session__open"
          type="button"
          aria-label=${t("claudeSessions.readLabel", { title })}
          ?disabled=${!interactionsEnabled || !host.connected}
          @click=${() => onOpenSession?.(host.hostId, session.threadId)}
        >
          ${icons.eye}<span>${t("claudeSessions.read")}</span>
        </button>
      </div>
    </article>
  `;
}

function renderHost(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  host: CodexSessionHostPayload,
  interactionsEnabled: boolean,
  onOpenSession: ClaudeSessionsProps["onOpenSession"],
): TemplateResult {
  const statusLabel = host.connected
    ? t("claudeSessions.host.connected")
    : t("claudeSessions.host.offline");
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
                ? t("claudeSessions.host.gateway")
                : t("claudeSessions.host.node")}
            </span>
          </div>
          <div class="codex-host__status ${host.connected ? "codex-host__status--online" : ""}">
            <span class="codex-host__status-dot" aria-hidden="true"></span>
            ${statusLabel}<span aria-hidden="true">·</span>
            ${t("claudeSessions.host.sessionCount", { count: String(host.sessions.length) })}
          </div>
        </div>
        ${host.nodeId
          ? html`<div class="codex-host__id" title=${host.nodeId}>${host.nodeId}</div>`
          : nothing}
      </header>
      ${host.error
        ? html`<div class="codex-host__error" role="status">
            ${icons.alertTriangle}
            <div>
              <strong>${t("claudeSessions.host.unavailable")}</strong
              ><span>${host.error.message}</span>
            </div>
          </div>`
        : nothing}
      ${host.sessions.length > 0
        ? html`<div class="codex-host__sessions">
            ${host.sessions.map((session) =>
              renderSession(host, interactionsEnabled, onOpenSession, session),
            )}
          </div>`
        : !host.error
          ? html`<div class="codex-host__empty">
              ${state.search.trim()
                ? t("claudeSessions.empty.search")
                : t("claudeSessions.empty.nonArchived")}
            </div>`
          : nothing}
      ${host.nextCursor
        ? html`<div class="codex-host__footer">
            <button
              class="btn btn--small"
              type="button"
              ?disabled=${state.loadingMoreHostIds.has(host.hostId) || !interactionsEnabled}
              @click=${() => void loadMoreClaudeSessions(state, client, host.hostId)}
            >
              ${state.loadingMoreHostIds.has(host.hostId)
                ? t("claudeSessions.loadingMore")
                : t("claudeSessions.loadMore")}
            </button>
          </div>`
        : nothing}
    </section>
  `;
}

function transcriptText(item: CodexTranscriptItem): string {
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }
  return "";
}

function transcriptLabel(item: CodexTranscriptItem): string {
  switch (item.type) {
    case "userMessage":
      return t("claudeSessions.transcript.you");
    case "agentMessage":
      return "Claude";
    case "reasoning":
      return t("claudeSessions.transcript.reasoning");
    case "toolCall":
      return t("claudeSessions.transcript.toolCall");
    case "toolResult":
      return t("claudeSessions.transcript.toolResult");
    default:
      return item.type || t("claudeSessions.transcript.item");
  }
}

function renderTranscriptItem(item: CodexTranscriptItem, index: number): TemplateResult {
  const text = transcriptText(item);
  const message = item.type === "userMessage" || item.type === "agentMessage";
  return html`
    <article
      class="codex-transcript__item ${message ? "codex-transcript__item--message" : ""}"
      data-item-type=${item.type ?? "unknown"}
    >
      <div class="codex-transcript__item-label">${transcriptLabel(item)}</div>
      ${text ? html`<div class="codex-transcript__text">${text}</div>` : nothing}
      <details class="codex-transcript__details" ?open=${!text}>
        <summary>${t("claudeSessions.transcript.details")}</summary>
        <pre>${JSON.stringify(item, null, 2)}</pre>
      </details>
      <span class="codex-transcript__index" aria-hidden="true">${index + 1}</span>
    </article>
  `;
}

function renderTranscript(props: ClaudeSessionsProps, state: CodexSessionsUiState) {
  const hostId = props.selectedHostId?.trim() ?? "";
  const threadId = props.selectedThreadId?.trim() ?? "";
  bindClaudeTranscript(state, props.client, hostId, threadId);
  const session = state.hosts
    .find((host) => host.hostId === hostId)
    ?.sessions.find((candidate) => candidate.threadId === threadId);
  return html`
    <section class="codex-transcript">
      <header class="codex-transcript__header">
        <button class="btn btn--small" type="button" @click=${() => props.onCloseSession?.()}>
          ${icons.arrowLeft}<span>${t("claudeSessions.transcript.back")}</span>
        </button>
        <div>
          <div class="codex-sessions__eyebrow">${t("claudeSessions.transcript.eyebrow")}</div>
          <h1>${session ? displayTitle(session) : threadId}</h1>
          <p>${threadId}</p>
        </div>
      </header>
      ${state.transcriptError
        ? html`<div class="callout danger" role="alert">${state.transcriptError}</div>`
        : nothing}
      <div class="codex-transcript__items" aria-live="polite">
        ${state.transcriptItems.map(renderTranscriptItem)}
      </div>
      ${state.transcriptLoading
        ? html`<div class="codex-sessions__loading">
            <span class="codex-sessions__spinner" aria-hidden="true"></span>
            ${t("claudeSessions.transcript.loading")}
          </div>`
        : nothing}
      ${state.transcriptNextCursor
        ? html`<button
            class="btn codex-transcript__more"
            type="button"
            ?disabled=${state.transcriptLoading}
            @click=${() =>
              void loadClaudeTranscript(state, props.client, hostId, threadId, { append: true })}
          >
            ${t("claudeSessions.transcript.loadMore")}
          </button>`
        : nothing}
    </section>
  `;
}

export function renderClaudeSessions(props: ClaudeSessionsProps) {
  const state = getClaudeSessionsState(props.host);
  state.requestUpdate = props.onRequestUpdate ?? null;
  configureClaudeSessionsPolling(state, props.client, props.connected);
  if (props.connected && !state.loading && !state.refreshedAtMs && !state.error) {
    void loadClaudeSessions(state, props.client);
  }
  if (props.selectedHostId && props.selectedThreadId) {
    return renderTranscript(props, state);
  }
  unbindClaudeTranscript(state);

  const hostErrors = state.hosts.filter((host) => host.error).length;
  const onlineHosts = state.hosts.filter((host) => host.connected).length;
  const sessionCount = state.hosts.reduce((count, host) => count + host.sessions.length, 0);
  return html`
    <section class="codex-sessions">
      <header class="codex-sessions__hero">
        <div>
          <div class="codex-sessions__eyebrow">${t("claudeSessions.eyebrow")}</div>
          <h1 class="codex-sessions__title">${t("claudeSessions.title")}</h1>
          <p class="codex-sessions__subtitle">${t("claudeSessions.subtitle")}</p>
        </div>
        <div class="codex-sessions__summary" aria-label=${t("claudeSessions.summaryLabel")}>
          <div>
            <strong>${sessionCount}</strong><span>${t("claudeSessions.summary.sessions")}</span>
          </div>
          <div>
            <strong>${onlineHosts}</strong><span>${t("claudeSessions.summary.onlineHosts")}</span>
          </div>
          <div>
            <strong>${state.hosts.length}</strong><span>${t("claudeSessions.summary.hosts")}</span>
          </div>
        </div>
      </header>
      <div class="codex-sessions__toolbar">
        <label class="codex-sessions__search">
          <span aria-hidden="true">${icons.search}</span>
          <input
            type="search"
            aria-label=${t("claudeSessions.searchLabel")}
            placeholder=${t("claudeSessions.searchPlaceholder")}
            ?disabled=${!props.connected}
            .value=${state.search}
            @input=${(event: Event) =>
              setClaudeSessionsSearch(
                state,
                props.client,
                (event.currentTarget as HTMLInputElement).value,
              )}
          />
        </label>
        <button
          class="btn btn--small codex-sessions__refresh"
          type="button"
          ?disabled=${state.loading || !props.connected}
          @click=${() => void loadClaudeSessions(state, props.client)}
        >
          ${icons.refresh}<span>${t("claudeSessions.refresh")}</span>
        </button>
      </div>
      ${!props.connected
        ? html`<div class="callout danger" role="alert">${t("claudeSessions.disconnected")}</div>`
        : nothing}
      ${state.error ? html`<div class="callout danger" role="alert">${state.error}</div>` : nothing}
      ${hostErrors > 0
        ? html`<div class="codex-sessions__partial" role="status">
            ${icons.alertTriangle}${t("claudeSessions.partial", { count: String(hostErrors) })}
          </div>`
        : nothing}
      <div class="codex-sessions__results" aria-live="polite">
        ${state.loading && state.hosts.length === 0
          ? html`<div class="codex-sessions__loading">${t("claudeSessions.loading")}</div>`
          : state.hosts.length === 0 && !state.error && props.connected
            ? html`<div class="codex-sessions__empty">
                <div class="codex-sessions__empty-icon" aria-hidden="true">${icons.terminal}</div>
                <h2>${t("claudeSessions.empty.title")}</h2>
                <p>${t("claudeSessions.empty.subtitle")}</p>
              </div>`
            : state.hosts.map((host) =>
                renderHost(state, props.client, host, props.connected, props.onOpenSession),
              )}
      </div>
    </section>
  `;
}
