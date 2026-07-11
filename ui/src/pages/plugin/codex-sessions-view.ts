// Control UI view for continuing and archiving Codex sessions through the Gateway.
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../../lib/format.ts";
import {
  archiveCodexSession,
  bindCodexTranscript,
  configureCodexSessionsPolling,
  continueCodexSession,
  getCodexSessionPendingAction,
  getCodexSessionsState,
  loadCodexSessions,
  loadCodexTranscript,
  loadMoreCodexSessions,
  setCodexSessionsSearch,
  unbindCodexTranscript,
  type CodexSessionHostPayload,
  type CodexSessionPayload,
  type CodexSessionsUiState,
  type CodexTranscriptItem,
} from "./codex-sessions-controller.ts";

type CodexSessionsProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate?: () => void;
  onContinueSession?: (sessionKey: string) => void;
  selectedHostId?: string;
  selectedThreadId?: string;
  onOpenSession?: (hostId: string, threadId: string) => void;
  onCloseSession?: () => void;
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
      return t("codexSessions.status.storedActivityUnknown");
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

function hostActionUnavailableReason(
  host: CodexSessionHostPayload,
  interactionsEnabled: boolean,
): string | undefined {
  if (!interactionsEnabled) {
    return t("codexSessions.actions.gatewayOffline");
  }
  if (!host.connected) {
    return t("codexSessions.actions.hostOffline");
  }
  if (host.kind !== "gateway") {
    return t("codexSessions.actions.remoteReadOnly");
  }
  return undefined;
}

function continueUnavailableReason(
  host: CodexSessionHostPayload,
  session: CodexSessionPayload,
  interactionsEnabled: boolean,
  opensExistingChat: boolean,
): string | undefined {
  const hostReason = hostActionUnavailableReason(host, interactionsEnabled);
  if (hostReason) {
    return hostReason;
  }
  if (opensExistingChat) {
    return undefined;
  }
  if (session.status === "active") {
    return t("codexSessions.actions.active");
  }
  if (session.status !== "idle" && session.status !== "notLoaded") {
    return t("codexSessions.actions.statusUnavailable");
  }
  return undefined;
}

function confirmCodexArchive(title: string): boolean {
  return (
    typeof globalThis.confirm === "function" &&
    globalThis.confirm(t("codexSessions.actions.archiveConfirmation", { title }))
  );
}

function archiveUnavailableReason(
  host: CodexSessionHostPayload,
  session: CodexSessionPayload,
  interactionsEnabled: boolean,
): string | undefined {
  const hostReason = hostActionUnavailableReason(host, interactionsEnabled);
  if (hostReason) {
    return hostReason;
  }
  if (session.status === "active") {
    return t("codexSessions.actions.active");
  }
  if (session.status !== "idle" && session.status !== "notLoaded") {
    return t("codexSessions.actions.statusUnavailable");
  }
  return undefined;
}

function renderSession(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  host: CodexSessionHostPayload,
  interactionsEnabled: boolean,
  onContinueSession: ((sessionKey: string) => void) | undefined,
  onOpenSession: ((hostId: string, threadId: string) => void) | undefined,
  session: CodexSessionPayload,
): TemplateResult {
  const title = displayTitle(session);
  const pendingAction = getCodexSessionPendingAction(state, host.hostId, session.threadId);
  const openClawSessionKey = session.openClawSessionKey?.trim();
  const opensExistingChat = Boolean(openClawSessionKey);
  const continueAsBranch =
    !opensExistingChat && (session.status === "idle" || session.status === "notLoaded");
  const continueLabel = opensExistingChat
    ? t("codexSessions.actions.openChatLabel", { title })
    : continueAsBranch
      ? t("codexSessions.actions.continueAsBranchLabel", { title })
      : t("codexSessions.actions.continueLabel", { title });
  const continueReason = continueUnavailableReason(
    host,
    session,
    interactionsEnabled,
    opensExistingChat,
  );
  const archiveReason = archiveUnavailableReason(host, session, interactionsEnabled);
  const continueTitle =
    continueReason ??
    (continueAsBranch ? t("codexSessions.actions.continueAsBranchHint") : continueLabel);
  const archiveTitle =
    archiveReason ??
    (session.status === "notLoaded"
      ? t("codexSessions.actions.archiveActivityUnknownHint")
      : t("codexSessions.actions.archiveLabel", { title }));
  const continueDisabled = Boolean(continueReason || pendingAction);
  const archiveDisabled = Boolean(archiveReason || pendingAction);
  const remoteViewOnly = host.kind !== "gateway";
  return html`
    <article
      class="codex-session"
      data-thread-id=${session.threadId}
      aria-label=${title}
      aria-busy=${String(Boolean(pendingAction))}
    >
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
        ${remoteViewOnly
          ? html`<div class="codex-session__view-only">
              ${icons.eye}<span>${t("codexSessions.actions.remoteReadOnly")}</span>
            </div>`
          : nothing}
      </div>
      <div class="codex-session__actions">
        <button
          class="btn btn--small codex-session__open"
          type="button"
          aria-label=${t("codexSessions.actions.readTranscriptLabel", { title })}
          ?disabled=${!interactionsEnabled || !host.connected}
          @click=${() => onOpenSession?.(host.hostId, session.threadId)}
        >
          ${icons.eye}<span>${t("codexSessions.actions.readTranscript")}</span>
        </button>
        <button
          class="btn btn--small codex-session__continue"
          type="button"
          aria-label=${continueLabel}
          title=${continueTitle}
          ?disabled=${continueDisabled}
          @click=${() => {
            void continueCodexSession(
              state,
              client,
              host.hostId,
              session.threadId,
              onContinueSession ?? (() => undefined),
            );
          }}
        >
          ${icons.play}<span>
            ${pendingAction === "continue"
              ? t("codexSessions.actions.continuing")
              : opensExistingChat
                ? t("codexSessions.actions.openChat")
                : continueAsBranch
                  ? t("codexSessions.actions.continueAsBranch")
                  : t("codexSessions.actions.continue")}
          </span>
        </button>
        <button
          class="btn btn--small codex-session__archive"
          type="button"
          aria-label=${t("codexSessions.actions.archiveLabel", { title })}
          title=${archiveTitle}
          ?disabled=${archiveDisabled}
          @click=${() => {
            if (!confirmCodexArchive(title)) {
              return;
            }
            void archiveCodexSession(state, client, host.hostId, session.threadId, true);
          }}
        >
          ${icons.archive}<span>${t("codexSessions.actions.archive")}</span>
        </button>
      </div>
    </article>
  `;
}

function visibleSessionsForHost(
  state: CodexSessionsUiState,
  host: CodexSessionHostPayload,
): CodexSessionPayload[] {
  return host.sessions.filter(
    (session) => getCodexSessionPendingAction(state, host.hostId, session.threadId) !== "archive",
  );
}

function renderHost(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  host: CodexSessionHostPayload,
  interactionsEnabled: boolean,
  onContinueSession: ((sessionKey: string) => void) | undefined,
  onOpenSession: ((hostId: string, threadId: string) => void) | undefined,
): TemplateResult {
  const loadingMore = state.loadingMoreHostIds.has(host.hostId);
  const visibleSessions = visibleSessionsForHost(state, host);
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
            ${t("codexSessions.host.sessionCount", { count: String(visibleSessions.length) })}
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
      ${visibleSessions.length > 0
        ? html`<div class="codex-host__sessions">
            ${visibleSessions.map((session) =>
              renderSession(
                state,
                client,
                host,
                interactionsEnabled,
                onContinueSession,
                onOpenSession,
                session,
              ),
            )}
          </div>`
        : !host.error
          ? html`<div class="codex-host__empty">
              ${state.search.trim()
                ? t("codexSessions.empty.search")
                : t("codexSessions.empty.nonArchived")}
            </div>`
          : nothing}
      ${host.nextCursor
        ? html`<div class="codex-host__footer">
            <button
              class="btn btn--small"
              type="button"
              aria-label=${`${t("codexSessions.loadMore")} — ${host.label}`}
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

function transcriptItemText(item: CodexTranscriptItem): string {
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }
  const fragments: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim()) {
        fragments.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "summary", "aggregatedOutput"]) {
      if (key in record) {
        visit(record[key]);
      }
    }
  };
  visit(item);
  return [...new Set(fragments)].join("\n\n");
}

function transcriptItemLabel(item: CodexTranscriptItem): string {
  switch (item.type) {
    case "userMessage":
      return t("codexSessions.transcript.you");
    case "agentMessage":
      return "Codex";
    case "reasoning":
      return t("codexSessions.transcript.reasoning");
    case "commandExecution":
      return t("codexSessions.transcript.command");
    case "fileChange":
      return t("codexSessions.transcript.fileChange");
    default:
      return item.type || t("codexSessions.transcript.item");
  }
}

function renderTranscriptItem(item: CodexTranscriptItem, index: number): TemplateResult {
  const text = transcriptItemText(item);
  const message = item.type === "userMessage" || item.type === "agentMessage";
  return html`
    <article
      class="codex-transcript__item ${message ? "codex-transcript__item--message" : ""}"
      data-item-type=${item.type ?? "unknown"}
    >
      <div class="codex-transcript__item-label">${transcriptItemLabel(item)}</div>
      ${text ? html`<div class="codex-transcript__text">${text}</div>` : nothing}
      <details class="codex-transcript__details" ?open=${!text}>
        <summary>${t("codexSessions.transcript.details")}</summary>
        <pre>${JSON.stringify(item, null, 2)}</pre>
      </details>
      <span class="codex-transcript__index" aria-hidden="true">${index + 1}</span>
    </article>
  `;
}

function renderTranscript(props: CodexSessionsProps, state: CodexSessionsUiState) {
  const hostId = props.selectedHostId?.trim() ?? "";
  const threadId = props.selectedThreadId?.trim() ?? "";
  bindCodexTranscript(state, props.client, hostId, threadId);
  const session = state.hosts
    .find((host) => host.hostId === hostId)
    ?.sessions.find((candidate) => candidate.threadId === threadId);
  return html`
    <section class="codex-transcript">
      <header class="codex-transcript__header">
        <button class="btn btn--small" type="button" @click=${() => props.onCloseSession?.()}>
          ${icons.arrowLeft}<span>${t("codexSessions.transcript.back")}</span>
        </button>
        <div>
          <div class="codex-sessions__eyebrow">${t("codexSessions.transcript.eyebrow")}</div>
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
            ${t("codexSessions.transcript.loading")}
          </div>`
        : nothing}
      ${state.transcriptNextCursor
        ? html`<button
            class="btn codex-transcript__more"
            type="button"
            ?disabled=${state.transcriptLoading}
            @click=${() =>
              void loadCodexTranscript(state, props.client, hostId, threadId, { append: true })}
          >
            ${t("codexSessions.transcript.loadMore")}
          </button>`
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
  if (props.selectedHostId && props.selectedThreadId) {
    return renderTranscript(props, state);
  }
  unbindCodexTranscript(state);

  const hostErrors = state.hosts.filter((host) => host.error).length;
  const onlineHosts = state.hosts.filter((host) => host.connected).length;
  const sessionCount = state.hosts.reduce(
    (count, host) => count + visibleSessionsForHost(state, host).length,
    0,
  );
  return html`
    <section class="codex-sessions">
      <header class="codex-sessions__hero">
        <div>
          <div class="codex-sessions__eyebrow">${t("codexSessions.eyebrow")}</div>
          <h1 class="codex-sessions__title">${t("codexSessions.title")}</h1>
          <p class="codex-sessions__subtitle">${t("codexSessions.interactiveSubtitle")}</p>
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
      ${state.actionError
        ? html`<div class="callout danger" role="alert">${state.actionError}</div>`
        : nothing}
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
                <p>${t("codexSessions.empty.supervisionSubtitle")}</p>
              </div>`
            : state.hosts.map((host) =>
                renderHost(
                  state,
                  props.client,
                  host,
                  props.connected,
                  props.onContinueSession,
                  props.onOpenSession,
                ),
              )}
      </div>
    </section>
  `;
}
