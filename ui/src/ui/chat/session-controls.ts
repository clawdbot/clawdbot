// Control UI chat module implements session controls behavior.
import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import {
  createChatSessionsLoadOverrides,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
} from "../app-chat.ts";
import type { AppViewState } from "../app-view-state.ts";
import { createChatModelOverride } from "../chat-model-ref.ts";
import {
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "../chat-model-select-state.ts";
import { refreshVisibleToolsEffectiveForCurrentSession } from "../controllers/agents.ts";
import { loadSessions } from "../controllers/sessions.ts";
import { formatDateTimeMs } from "../format.ts";
import { icons } from "../icons.ts";
import { isMonitoredAuthProvider } from "../model-auth-helpers.ts";
import { pathForTab } from "../navigation.ts";
import { collectQuotaWindowsFromAuthStatus, formatQuotaReset } from "../provider-quota-summary.ts";
import { pushUniqueTrimmedSelectOption } from "../select-options.ts";
import { isCronSessionKey, resolveSessionDisplayName } from "../session-display.ts";
import {
  buildAgentMainSessionKey,
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../session-key.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import {
  formatInheritedThinkingLabel,
  formatThinkingOverrideLabel,
  normalizeThinkingOptionValue,
} from "../thinking-labels.ts";
import {
  type ThinkingCatalogEntry,
  listThinkingLevelLabels,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
} from "../thinking.ts";
import type { GatewayThinkingLevelOption, SessionsListResult } from "../types.ts";

type ChatSessionSwitchHandler = (state: AppViewState, nextSessionKey: string) => void;
type ChatSessionSelectSurface = "desktop" | "mobile" | "sidebar";
type ChatSessionPickerSearchController = {
  activeRequestId: number | null;
  activeRequestSignature: string | null;
  nextRequestId: number;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
};

type ChatInlineSelectOption = {
  value: string;
  label: string;
};

const FAST_MODE_PROVIDER_IDS = new Set([
  "anthropic",
  "minimax",
  "minimax-portal",
  "openai",
  "openrouter",
  "xai",
]);

const CHAT_SESSION_PICKER_SEARCH_DEBOUNCE_MS = 300;
const chatSessionPickerSearchControllers = new WeakMap<
  AppViewState,
  ChatSessionPickerSearchController
>();

function setChatError(state: AppViewState, error: string | null) {
  state.lastError = error;
  state.chatError = error;
}

export function renderChatSessionSelect(
  state: AppViewState,
  onSwitchSession: ChatSessionSwitchHandler = () => undefined,
  options: {
    compact?: boolean;
    sessionSwitcherOnly?: boolean;
    surface?: ChatSessionSelectSurface;
  } = {},
) {
  rememberChatAgentSessionRows(state, state.sessionsResult);
  const sessionGroups = resolveSessionOptionGroups(state, state.sessionKey, state.sessionsResult);
  const agentOptions = resolveChatAgentFilterOptions(state);
  const hasAgentSelect = agentOptions.length > 1;
  const compact = options.compact ?? false;
  const agentSelect = compact ? "" : renderChatAgentSelect(state, onSwitchSession, agentOptions);
  const sessionSwitcherOnly = options.sessionSwitcherOnly ?? false;
  const modelSelect = sessionSwitcherOnly ? "" : renderChatModelSelect(state);
  const quotaPill = sessionSwitcherOnly ? "" : renderChatQuotaPill(state);
  const surface = options.surface ?? "desktop";
  const selectedSessionLabel = resolveSelectedChatSessionLabel(state, sessionGroups);
  const pickerOpen = state.chatSessionPickerOpen && state.chatSessionPickerSurface === surface;
  const flashSession = state.sessionSwitchFlashKey === state.sessionKey;
  const rowClass = [
    "chat-controls__session-row",
    sessionSwitcherOnly ? "chat-controls__session-row--session-switcher" : "",
    hasAgentSelect && !compact ? "" : "chat-controls__session-row--single-agent",
    compact ? "chat-controls__session-row--compact" : "",
    quotaPill ? "chat-controls__session-row--has-quota" : "",
    flashSession ? "chat-controls__session-row--flash" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${rowClass}>
      ${agentSelect}
      ${renderChatSessionPicker({
        state,
        onSwitchSession,
        surface,
        selectedSessionLabel,
        pickerOpen,
        disabled: !state.connected || !state.client,
        compact,
      })}
      ${modelSelect} ${quotaPill}
    </div>
    <div class="chat-controls__session-notice" role="status" aria-live="polite">
      ${state.sessionSwitchNotice?.text ?? ""}
    </div>
  `;
}

function resolveNextChatSessionOffset(
  sessions: SessionsListResult | null | undefined,
): number | null {
  if (!sessions?.hasMore) {
    return null;
  }
  if (typeof sessions.nextOffset === "number" && Number.isFinite(sessions.nextOffset)) {
    return Math.max(0, Math.floor(sessions.nextOffset));
  }
  return sessions.sessions.length;
}

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    ...createChatSessionsLoadOverrides(state),
    ...scopedAgentListParamsForSession(state, state.sessionKey),
  });
}

function requestHostUpdate(state: AppViewState) {
  (state as AppViewState & { requestUpdate?: () => void }).requestUpdate?.();
}

function getChatSessionPickerSearchController(
  state: AppViewState,
): ChatSessionPickerSearchController {
  let controller = chatSessionPickerSearchControllers.get(state);
  if (!controller) {
    controller = {
      activeRequestId: null,
      activeRequestSignature: null,
      nextRequestId: 0,
      timer: null,
    };
    chatSessionPickerSearchControllers.set(state, controller);
  }
  return controller;
}

function clearChatSessionPickerSearchTimer(state: AppViewState) {
  const controller = getChatSessionPickerSearchController(state);
  if (controller.timer) {
    globalThis.clearTimeout(controller.timer);
    controller.timer = null;
  }
}

function invalidateChatSessionPickerSearchRequests(state: AppViewState) {
  const controller = getChatSessionPickerSearchController(state);
  controller.nextRequestId += 1;
  controller.activeRequestId = null;
  controller.activeRequestSignature = null;
}

function beginChatSessionPickerSearchRequest(
  state: AppViewState,
  signature: string,
): number | null {
  const controller = getChatSessionPickerSearchController(state);
  if (controller.activeRequestSignature === signature) {
    return null;
  }
  controller.nextRequestId += 1;
  controller.activeRequestId = controller.nextRequestId;
  controller.activeRequestSignature = signature;
  return controller.activeRequestId;
}

function isCurrentChatSessionPickerSearchRequest(state: AppViewState, requestId: number): boolean {
  return getChatSessionPickerSearchController(state).activeRequestId === requestId;
}

function finishChatSessionPickerSearchRequest(state: AppViewState, requestId: number) {
  if (!isCurrentChatSessionPickerSearchRequest(state, requestId)) {
    return;
  }
  const controller = getChatSessionPickerSearchController(state);
  controller.activeRequestId = null;
  controller.activeRequestSignature = null;
}

function createChatSessionPickerRequestSignature(options: {
  append?: boolean;
  offset?: number;
  query: string;
}) {
  return [
    options.query,
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0,
    options.append === true ? "append" : "replace",
  ].join("\n");
}

function focusChatSessionPickerSearch(state: AppViewState) {
  const updateComplete = (state as AppViewState & { updateComplete?: Promise<unknown> })
    .updateComplete;
  const focus = () => {
    document.querySelector<HTMLInputElement>('[data-chat-session-picker-search="true"]')?.focus();
  };
  if (updateComplete) {
    void updateComplete.then(focus);
    return;
  }
  setTimeout(focus, 0);
}

function openChatSessionPicker(state: AppViewState, surface: ChatSessionSelectSurface) {
  state.chatSessionPickerOpen = true;
  state.chatSessionPickerSurface = surface;
  state.chatSessionPickerError = null;
  if (!state.chatSessionPickerResult && !state.chatSessionPickerAppliedQuery) {
    void loadChatSessionPickerPage(state);
  }
  requestHostUpdate(state);
  focusChatSessionPickerSearch(state);
}

function closeChatSessionPicker(state: AppViewState) {
  clearChatSessionPickerSearchTimer(state);
  state.chatSessionPickerOpen = false;
  state.chatSessionPickerSurface = null;
  requestHostUpdate(state);
}

export function resetChatSessionPickerState(state: AppViewState) {
  clearChatSessionPickerSearchTimer(state);
  invalidateChatSessionPickerSearchRequests(state);
  state.chatSessionPickerOpen = false;
  state.chatSessionPickerSurface = null;
  state.chatSessionPickerQuery = "";
  state.chatSessionPickerAppliedQuery = "";
  state.chatSessionPickerLoading = false;
  state.chatSessionPickerError = null;
  state.chatSessionPickerResult = null;
}

function toggleChatSessionPicker(state: AppViewState, surface: ChatSessionSelectSurface) {
  if (state.chatSessionPickerOpen && state.chatSessionPickerSurface === surface) {
    closeChatSessionPicker(state);
    return;
  }
  openChatSessionPicker(state, surface);
}

function createChatSessionPickerRequestParams(
  state: AppViewState,
  options: { query?: string; offset?: number } = {},
): Record<string, unknown> {
  const overrides = createChatSessionsLoadOverrides(state, {
    search: options.query,
    offset: options.offset,
  });
  const params: Record<string, unknown> = {
    includeGlobal: overrides.includeGlobal,
    includeUnknown: overrides.includeUnknown,
    configuredAgentsOnly: overrides.configuredAgentsOnly,
    limit: overrides.limit,
  };
  const activeAgentSession = parseAgentSessionKey(state.sessionKey);
  const activeSessionRow = state.sessionsResult?.sessions.find(
    (row) => row.key === state.sessionKey,
  );
  const isGlobalScopeSession =
    activeSessionRow?.kind === "global" ||
    activeSessionRow?.kind === "unknown" ||
    state.sessionKey === "global" ||
    state.sessionKey === "unknown";
  if (activeAgentSession || !isGlobalScopeSession) {
    params.agentId = normalizeAgentId(
      activeAgentSession?.agentId ?? state.agentsList?.defaultId ?? "main",
    );
  }
  const offset =
    typeof overrides.offset === "number" && Number.isFinite(overrides.offset)
      ? Math.max(0, Math.floor(overrides.offset))
      : 0;
  if (offset > 0) {
    params.offset = offset;
  }
  const search = normalizeOptionalString(overrides.search ?? undefined);
  if (search) {
    params.search = search;
  }
  return params;
}

function projectChatSessionPickerResult(
  state: AppViewState,
  result: SessionsListResult,
): SessionsListResult {
  if (state.sessionsShowArchived) {
    return result;
  }
  const sessions = result.sessions.filter((row) => row.key && row.archived !== true);
  return {
    ...result,
    count: sessions.length,
    sessions,
  };
}

function appendChatSessionPickerResult(
  previous: SessionsListResult,
  page: SessionsListResult,
): SessionsListResult {
  const rowsByKey = new Map(previous.sessions.map((row) => [row.key, row] as const));
  const sessions = [...previous.sessions];
  for (const row of page.sessions) {
    if (rowsByKey.has(row.key)) {
      continue;
    }
    rowsByKey.set(row.key, row);
    sessions.push(row);
  }
  return {
    ...page,
    count: sessions.length,
    sessions,
    totalCount: page.totalCount ?? previous.totalCount,
  };
}

async function loadChatSessionPickerPage(
  state: AppViewState,
  options: { query?: string; offset?: number; append?: boolean } = {},
) {
  if (!state.client || !state.connected) {
    return;
  }
  const query = normalizeOptionalString(options.query ?? state.chatSessionPickerAppliedQuery) ?? "";
  const requestId = beginChatSessionPickerSearchRequest(
    state,
    createChatSessionPickerRequestSignature({
      append: options.append,
      offset: options.offset,
      query,
    }),
  );
  if (requestId === null) {
    return;
  }
  state.chatSessionPickerLoading = true;
  state.chatSessionPickerError = null;
  requestHostUpdate(state);
  try {
    const page = projectChatSessionPickerResult(
      state,
      await state.client.request<SessionsListResult>(
        "sessions.list",
        createChatSessionPickerRequestParams(state, { query, offset: options.offset }),
      ),
    );
    if (!isCurrentChatSessionPickerSearchRequest(state, requestId)) {
      return;
    }
    const previous = state.chatSessionPickerResult ?? state.sessionsResult;
    state.chatSessionPickerResult =
      options.append === true && previous ? appendChatSessionPickerResult(previous, page) : page;
    state.chatSessionPickerAppliedQuery = query;
  } catch (err) {
    if (!isCurrentChatSessionPickerSearchRequest(state, requestId)) {
      return;
    }
    state.chatSessionPickerError = String(err);
  } finally {
    if (isCurrentChatSessionPickerSearchRequest(state, requestId)) {
      finishChatSessionPickerSearchRequest(state, requestId);
      state.chatSessionPickerLoading = false;
      requestHostUpdate(state);
    }
  }
}

async function applyChatSessionPickerSearch(state: AppViewState) {
  clearChatSessionPickerSearchTimer(state);
  const query = normalizeOptionalString(state.chatSessionPickerQuery) ?? "";
  if (!query) {
    clearChatSessionPickerSearch(state);
    return;
  }
  if (query === state.chatSessionPickerAppliedQuery && state.chatSessionPickerResult) {
    return;
  }
  await loadChatSessionPickerPage(state, { query });
}

function clearChatSessionPickerSearch(state: AppViewState, options: { focus?: boolean } = {}) {
  clearChatSessionPickerSearchTimer(state);
  invalidateChatSessionPickerSearchRequests(state);
  state.chatSessionPickerQuery = "";
  state.chatSessionPickerAppliedQuery = "";
  state.chatSessionPickerError = null;
  state.chatSessionPickerResult = null;
  state.chatSessionPickerLoading = false;
  requestHostUpdate(state);
  if (state.chatSessionPickerOpen) {
    void loadChatSessionPickerPage(state);
  }
  if (options.focus ?? true) {
    focusChatSessionPickerSearch(state);
  }
}

function scheduleChatSessionPickerSearch(state: AppViewState) {
  clearChatSessionPickerSearchTimer(state);
  const controller = getChatSessionPickerSearchController(state);
  controller.timer = globalThis.setTimeout(() => {
    controller.timer = null;
    void applyChatSessionPickerSearch(state);
  }, CHAT_SESSION_PICKER_SEARCH_DEBOUNCE_MS);
}

function updateChatSessionPickerSearchQuery(state: AppViewState, nextQuery: string) {
  state.chatSessionPickerQuery = nextQuery;
  const query = normalizeOptionalString(nextQuery) ?? "";
  if (!query) {
    clearChatSessionPickerSearch(state, { focus: false });
    return;
  }
  if (query !== state.chatSessionPickerAppliedQuery || !state.chatSessionPickerResult) {
    invalidateChatSessionPickerSearchRequests(state);
    state.chatSessionPickerError = null;
    state.chatSessionPickerLoading = false;
    scheduleChatSessionPickerSearch(state);
  } else {
    clearChatSessionPickerSearchTimer(state);
  }
  requestHostUpdate(state);
}

async function loadMoreChatSessionPickerResults(state: AppViewState) {
  const result = state.chatSessionPickerResult;
  const offset = resolveNextChatSessionOffset(result);
  if (offset === null) {
    return;
  }
  await loadChatSessionPickerPage(state, {
    query: state.chatSessionPickerAppliedQuery,
    offset,
    append: true,
  });
}

function resolveChatSessionRow(
  state: AppViewState,
  sessionKey: string,
): SessionsListResult["sessions"][number] | undefined {
  return (
    state.sessionsResult?.sessions.find((row) => row.key === sessionKey) ??
    state.chatSessionPickerResult?.sessions.find((row) => row.key === sessionKey)
  );
}

function resolveChatSessionPickerResult(state: AppViewState): SessionsListResult | null {
  if (
    state.chatSessionPickerResult ||
    state.chatSessionPickerAppliedQuery ||
    state.chatSessionPickerOpen
  ) {
    return state.chatSessionPickerResult;
  }
  return state.sessionsResult;
}

function resolveChatSessionPickerRows(
  state: AppViewState,
  result: SessionsListResult | null,
): { row: SessionsListResult["sessions"][number]; label: string }[] {
  const rowsByKey = new Map((result?.sessions ?? []).map((row) => [row.key, row] as const));
  return resolveSessionOptionGroups(state, state.sessionKey, result)
    .flatMap((group) => group.options)
    .filter((option) => rowsByKey.has(option.key))
    .map((option) => ({
      row: rowsByKey.get(option.key)!,
      label: option.label,
    }));
}

function resolveSelectedChatSessionLabel(
  state: AppViewState,
  sessionGroups: SessionOptionGroup[],
): string {
  const row = resolveChatSessionRow(state, state.sessionKey);
  const displayName = resolveSessionDisplayName(state.sessionKey, row);
  if (displayName !== state.sessionKey) {
    return displayName;
  }
  return (
    sessionGroups.flatMap((group) => group.options).find((entry) => entry.key === state.sessionKey)
      ?.label ?? state.sessionKey
  );
}

function formatChatSessionPickerMeta(row: SessionsListResult["sessions"][number]): string {
  const parts = [
    normalizeOptionalString(row.surface),
    [normalizeOptionalString(row.modelProvider), normalizeOptionalString(row.model)]
      .filter(Boolean)
      .join("/"),
  ].filter(Boolean);
  const updatedAt = formatDateTimeMs(row.updatedAt, undefined, "");
  if (updatedAt) {
    parts.push(updatedAt);
  }
  return parts.join(" · ");
}

function renderChatSessionPicker(params: {
  state: AppViewState;
  onSwitchSession: ChatSessionSwitchHandler;
  surface: ChatSessionSelectSurface;
  selectedSessionLabel: string;
  pickerOpen: boolean;
  disabled: boolean;
  compact: boolean;
}) {
  const { state, onSwitchSession, surface, selectedSessionLabel, pickerOpen, disabled, compact } =
    params;
  const pickerId = `chat-session-picker-${surface}`;
  return html`
    <div class="chat-controls__session chat-controls__session-picker">
      <button
        class="chat-controls__session-trigger"
        data-chat-session-select="true"
        type="button"
        title=${selectedSessionLabel}
        aria-label=${t("chat.selectors.session")}
        aria-haspopup="dialog"
        aria-expanded=${pickerOpen ? "true" : "false"}
        aria-controls=${pickerId}
        ?disabled=${disabled}
        @click=${() => toggleChatSessionPicker(state, surface)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openChatSessionPicker(state, surface);
          }
        }}
      >
        ${compact
          ? html`<span class="chat-controls__session-trigger-compact-icon" aria-hidden="true">
              ${icons.messageSquare}
            </span>`
          : ""}
        <span class="chat-controls__session-trigger-label">${selectedSessionLabel}</span>
        <span class="chat-controls__session-trigger-icon" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </button>
      ${pickerOpen ? renderChatSessionPickerPopover(state, onSwitchSession, pickerId) : ""}
    </div>
  `;
}

function renderChatSessionPickerPopover(
  state: AppViewState,
  onSwitchSession: ChatSessionSwitchHandler,
  pickerId: string,
) {
  const result = resolveChatSessionPickerResult(state);
  const pickerRows = resolveChatSessionPickerRows(state, result);
  const controlsDisabled = !state.connected || !state.client;
  const normalizedQuery = normalizeOptionalString(state.chatSessionPickerQuery) ?? "";
  const searchPending = normalizedQuery !== state.chatSessionPickerAppliedQuery;
  const loadMoreDisabled = controlsDisabled || state.chatSessionPickerLoading || searchPending;
  const hasQuery =
    state.chatSessionPickerQuery.trim() !== "" || state.chatSessionPickerAppliedQuery.trim() !== "";
  const loadMoreOffset = resolveNextChatSessionOffset(result);
  const shownCount = pickerRows.length;
  const totalCount = result?.totalCount;
  const countLabel =
    typeof totalCount === "number" && Number.isFinite(totalCount)
      ? `${shownCount} / ${totalCount}`
      : String(shownCount);

  return html`
    <div
      id=${pickerId}
      class="chat-session-picker"
      role="dialog"
      aria-label=${t("chat.selectors.session")}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeChatSessionPicker(state);
        }
      }}
    >
      <div class="chat-session-picker__search-row">
        <label class="field chat-session-picker__search">
          <input
            data-chat-session-picker-search="true"
            type="search"
            placeholder=${t("chat.selectors.sessionSearch")}
            aria-label=${t("chat.selectors.sessionSearch")}
            .value=${state.chatSessionPickerQuery}
            ?disabled=${controlsDisabled}
            @input=${(event: Event) => {
              updateChatSessionPickerSearchQuery(state, (event.target as HTMLInputElement).value);
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void applyChatSessionPickerSearch(state);
              }
            }}
            @blur=${() => {
              if (normalizeOptionalString(state.chatSessionPickerQuery)) {
                void applyChatSessionPickerSearch(state);
              }
            }}
          />
        </label>
        <button
          class="btn btn--ghost btn--icon chat-session-picker__icon-button"
          data-chat-session-search-submit="true"
          type="button"
          title=${t("common.search")}
          aria-label=${t("common.search")}
          ?disabled=${controlsDisabled}
          @click=${() => void applyChatSessionPickerSearch(state)}
        >
          ${icons.search}
        </button>
        ${hasQuery
          ? html`<button
              class="btn btn--ghost btn--icon chat-session-picker__icon-button"
              data-chat-session-search-clear="true"
              type="button"
              title=${t("chat.selectors.clearSessionSearch")}
              aria-label=${t("chat.selectors.clearSessionSearch")}
              ?disabled=${controlsDisabled}
              @click=${() => clearChatSessionPickerSearch(state)}
            >
              ${icons.x}
            </button>`
          : ""}
      </div>
      ${state.chatSessionPickerError
        ? html`<div class="chat-session-picker__status" role="alert">
            ${state.chatSessionPickerError}
          </div>`
        : ""}
      <div class="chat-session-picker__list" role="listbox">
        ${state.chatSessionPickerLoading && pickerRows.length === 0
          ? html`<div class="chat-session-picker__status">${t("common.loading")}</div>`
          : ""}
        ${!state.chatSessionPickerLoading && pickerRows.length === 0
          ? html`<div class="chat-session-picker__status">${t("sessionsView.noSessions")}</div>`
          : ""}
        ${repeat(
          pickerRows,
          (entry) => entry.row.key,
          (entry) => {
            const { row, label } = entry;
            const meta = formatChatSessionPickerMeta(row);
            const selected = row.key === state.sessionKey;
            return html`
              <button
                class="chat-session-picker__option ${selected
                  ? "chat-session-picker__option--selected"
                  : ""}"
                data-chat-session-picker-option="true"
                data-session-key=${row.key}
                role="option"
                aria-selected=${selected ? "true" : "false"}
                title=${label}
                type="button"
                @click=${() => {
                  closeChatSessionPicker(state);
                  if (row.key !== state.sessionKey) {
                    onSwitchSession(state, row.key);
                  }
                }}
              >
                <span class="chat-session-picker__option-main">
                  <span class="chat-session-picker__option-label">${label}</span>
                  ${meta ? html`<span class="chat-session-picker__option-meta">${meta}</span>` : ""}
                </span>
                ${selected
                  ? html`<span class="chat-session-picker__option-check" aria-hidden="true">
                      ${icons.check}
                    </span>`
                  : ""}
              </button>
            `;
          },
        )}
      </div>
      <div class="chat-session-picker__footer">
        <span class="chat-session-picker__count">${countLabel}</span>
        ${loadMoreOffset !== null
          ? html`<button
              class="btn btn--ghost btn--sm"
              data-chat-session-load-more="true"
              type="button"
              ?disabled=${loadMoreDisabled}
              @click=${() => void loadMoreChatSessionPickerResults(state)}
            >
              ${t("chat.selectors.loadMoreSessions")}
            </button>`
          : ""}
      </div>
    </div>
  `;
}

function renderChatQuotaPill(state: AppViewState) {
  const windows = collectQuotaWindowsFromAuthStatus(
    state.modelAuthStatusResult,
    isMonitoredAuthProvider,
  );
  const primary = windows[0];
  if (!primary) {
    return "";
  }
  const secondary = windows.find(
    (entry) => entry.displayName !== primary.displayName || entry.label !== primary.label,
  );
  const reset = formatQuotaReset(primary.resetAt);
  const detail = [primary.displayName, primary.label, reset ? `resets ${reset}` : null]
    .filter(Boolean)
    .join(" · ");
  const secondaryDetail = secondary
    ? `${secondary.displayName}${secondary.label ? ` ${secondary.label}` : ""} ${secondary.remaining}% left`
    : null;
  const title = [detail, secondaryDetail].filter(Boolean).join(" · ");
  const severity = primary.remaining <= 10 ? "danger" : primary.remaining <= 25 ? "warn" : "ok";

  return html`
    <a
      class="chat-controls__quota chat-controls__quota--${severity}"
      href=${pathForTab("usage", state.basePath)}
      title=${title}
      aria-label=${`Provider usage: ${title}`}
      data-chat-provider-usage="true"
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        state.setTab("usage");
      }}
    >
      <span class="chat-controls__quota-label">${t("tabs.usage")}</span>
      <span class="chat-controls__quota-value">${primary.remaining}%</span>
    </a>
  `;
}

function renderChatAgentSelect(
  state: AppViewState,
  onSwitchSession: ChatSessionSwitchHandler,
  options = resolveChatAgentFilterOptions(state),
) {
  if (options.length <= 1) {
    return "";
  }
  const activeAgentId = resolveChatAgentFilterId(state, state.sessionKey);
  const selectedLabel = options.find((entry) => entry.id === activeAgentId)?.label ?? activeAgentId;
  return html`
    <label class="field chat-controls__session chat-controls__agent">
      <select
        data-chat-agent-filter="true"
        aria-label=${t("chat.selectors.agentFilter")}
        title=${selectedLabel}
        .value=${activeAgentId}
        ?disabled=${!state.connected}
        @change=${(e: Event) => {
          const nextAgentId = normalizeAgentId((e.target as HTMLSelectElement).value);
          if (nextAgentId === activeAgentId) {
            return;
          }
          onSwitchSession(state, resolvePreferredSessionForAgent(state, nextAgentId));
        }}
      >
        ${repeat(
          options,
          (entry) => entry.id,
          (entry) =>
            html`<option value=${entry.id} ?selected=${entry.id === activeAgentId}>
              ${entry.label}
            </option>`,
        )}
      </select>
    </label>
  `;
}

async function refreshVisibleToolsEffectiveForCurrentSessionLazy(state: AppViewState) {
  return refreshVisibleToolsEffectiveForCurrentSession(state);
}

export function renderChatModelSelect(state: AppViewState) {
  const { currentOverride, defaultLabel, options } = resolveChatModelSelectState(state);
  const thinking = resolveChatThinkingSelectState(state);
  const fastMode = resolveChatFastModeSelectState(state, currentOverride);
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const disabled =
    !state.connected ||
    busy ||
    Boolean(state.chatModelSwitchPromises?.[state.sessionKey]) ||
    (state.chatModelsLoading && options.length === 0) ||
    !state.client;
  const thinkingDisabled =
    !state.connected ||
    busy ||
    !state.client ||
    (thinking.options.length === 0 && thinking.currentOverride === "");
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (options.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  const selectedThinkingLabel =
    thinking.currentOverride === ""
      ? thinking.defaultLabel
      : (thinking.options.find((entry) => entry.value === thinking.currentOverride)?.label ??
        thinking.currentOverride);
  const modelOptions = [{ value: "", label: defaultLabel }, ...options];
  return renderChatModelReasoningSelect({
    disabled,
    modelOptions,
    selectedModelLabel: selectedLabel,
    selectedModelValue: currentOverride,
    selectedThinkingLabel,
    selectedThinkingValue: thinking.currentOverride,
    fastMode,
    thinkingDisabled,
    thinkingOptions: [{ value: "", label: thinking.defaultLabel }, ...thinking.options],
    onModelSelect: (next) => switchChatModel(state, next),
    onFastModeSelect: (next) => switchChatFastMode(state, next),
    onThinkingSelect: (next) => switchChatThinkingLevel(state, next),
  });
}

type ChatThinkingSelectOption = {
  value: string;
  label: string;
};

type ChatThinkingSelectState = {
  currentOverride: string;
  defaultLabel: string;
  options: ChatThinkingSelectOption[];
};

type ChatFastModeSelectState = {
  currentOverride: "" | "on" | "off";
  disabled: boolean;
  options: ChatInlineSelectOption[];
  supported: boolean;
};

function resolveThinkingTargetModel(state: AppViewState): {
  provider: string | null;
  model: string | null;
} {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  return {
    provider: activeRow?.modelProvider ?? state.sessionsResult?.defaults?.modelProvider ?? null,
    model: activeRow?.model ?? state.sessionsResult?.defaults?.model ?? null,
  };
}

function resolveProviderFromModelValue(
  value: string,
  catalog: AppViewState["chatModelCatalog"],
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const separator = trimmed.indexOf("/");
  if (separator > 0) {
    return trimmed.slice(0, separator).toLowerCase();
  }
  return (
    catalog
      .find((entry) => entry.id.trim().toLowerCase() === trimmed.toLowerCase())
      ?.provider.trim()
      .toLowerCase() || null
  );
}

function resolveChatFastModeSelectState(
  state: AppViewState,
  currentModelOverride: string,
): ChatFastModeSelectState {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const { provider } = resolveThinkingTargetModel(state);
  const effectiveProvider =
    resolveProviderFromModelValue(currentModelOverride, state.chatModelCatalog ?? []) ??
    provider?.trim().toLowerCase() ??
    null;
  const currentOverride =
    activeRow?.fastMode === true ? "on" : activeRow?.fastMode === false ? "off" : "";
  const supported = Boolean(
    (effectiveProvider && FAST_MODE_PROVIDER_IDS.has(effectiveProvider)) || currentOverride,
  );
  return {
    currentOverride,
    disabled:
      !supported ||
      !state.connected ||
      state.chatLoading ||
      state.chatSending ||
      Boolean(state.chatRunId) ||
      state.chatStream !== null ||
      !state.client,
    options: [
      { value: "", label: "Default" },
      { value: "on", label: "Fast" },
      { value: "off", label: "Standard" },
    ],
    supported,
  };
}

function sessionModelMatchesDefaults(
  row: SessionsListResult["sessions"][number] | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
): boolean {
  return (
    (!row?.modelProvider || row.modelProvider === defaults?.modelProvider) &&
    (!row?.model || row.model === defaults?.model)
  );
}

function buildThinkingOptions(
  levels: readonly GatewayThinkingLevelOption[],
  currentOverride: string,
): ChatThinkingSelectOption[] {
  const seen = new Set<string>();
  const options: ChatThinkingSelectOption[] = [];

  const addOption = (value: string, label?: string) => {
    const normalizedValue = normalizeThinkingOptionValue(value);
    pushUniqueTrimmedSelectOption(options, seen, normalizedValue, () =>
      formatThinkingOverrideLabel(normalizedValue, label),
    );
  };

  for (const level of levels) {
    addOption(level.id, level.label);
  }
  if (currentOverride) {
    addOption(currentOverride);
  }
  return options;
}

function isOffThinkingOption(value: string | null | undefined): boolean {
  return normalizeThinkingOptionValue(value ?? "") === "off";
}

function isOffOnlyThinkingLevels(levels: readonly GatewayThinkingLevelOption[]): boolean {
  return levels.every((level) => isOffThinkingOption(level.id || level.label));
}

function resolveThinkingLevelOptions(
  activeRow: SessionsListResult["sessions"][number] | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  provider: string | null,
  model: string | null,
  catalog: readonly ThinkingCatalogEntry[],
): GatewayThinkingLevelOption[] {
  const sessionModelMatchesDefaultsLocal =
    (!activeRow?.modelProvider || activeRow.modelProvider === defaults?.modelProvider) &&
    (!activeRow?.model || activeRow.model === defaults?.model);
  const catalogEntry =
    provider && model
      ? catalog.find((entry) => entry.provider === provider && entry.id === model)
      : undefined;
  const explicitLevels =
    (activeRow?.thinkingLevels?.length ? activeRow.thinkingLevels : null) ??
    (sessionModelMatchesDefaultsLocal && defaults?.thinkingLevels?.length
      ? defaults.thinkingLevels
      : null);
  if (explicitLevels) {
    if (catalogEntry?.reasoning === false && isOffOnlyThinkingLevels(explicitLevels)) {
      return [];
    }
    return explicitLevels;
  }
  const explicitLabels =
    (activeRow?.thinkingOptions?.length ? activeRow.thinkingOptions : null) ??
    (sessionModelMatchesDefaultsLocal && defaults?.thinkingOptions?.length
      ? defaults.thinkingOptions
      : null);
  if (catalogEntry?.reasoning === false) {
    if (!explicitLabels || explicitLabels.every(isOffThinkingOption)) {
      return [];
    }
  }
  const labels =
    explicitLabels ??
    (provider && model ? listThinkingLevelLabels(provider, model) : listThinkingLevelLabels());
  return labels.map((label) => ({
    id: normalizeThinkLevel(label) ?? normalizeLowercaseStringOrEmpty(label),
    label,
  }));
}

export function resolveChatThinkingSelectState(state: AppViewState): ChatThinkingSelectState {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const persisted = activeRow?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const defaults = state.sessionsResult?.defaults;
  const { provider, model } = resolveThinkingTargetModel(state);
  const levels = resolveThinkingLevelOptions(
    activeRow,
    defaults,
    provider,
    model,
    state.chatModelCatalog ?? [],
  );
  const defaultFromSessionDefaults =
    (!activeRow || sessionModelMatchesDefaults(activeRow, defaults)) && defaults?.thinkingDefault
      ? defaults.thinkingDefault
      : undefined;
  const defaultLevel =
    activeRow?.thinkingDefault ??
    defaultFromSessionDefaults ??
    (provider && model
      ? resolveThinkingDefaultForModel({
          provider,
          model,
          catalog: state.chatModelCatalog ?? [],
        })
      : "off");
  const effectiveOverride = levels.length === 0 && currentOverride === "off" ? "" : currentOverride;
  return {
    currentOverride: effectiveOverride,
    defaultLabel: formatInheritedThinkingLabel(defaultLevel),
    options: buildThinkingOptions(levels, effectiveOverride),
  };
}

function formatCombinedPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

function formatCombinedPickerModelOptionLabel(
  option: ChatInlineSelectOption,
  selected: boolean,
): string {
  return option.value === "" && selected
    ? formatCombinedPickerModelLabel(option.label)
    : option.label;
}

function formatCombinedPickerThinkingLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

function formatCombinedPickerThinkingOptionLabel(option: ChatInlineSelectOption): string {
  return option.value === "" ? "Default" : formatCombinedPickerThinkingLabel(option.label);
}

function renderChatModelReasoningSelect(params: {
  fastMode: ChatFastModeSelectState;
  disabled: boolean;
  modelOptions: ChatInlineSelectOption[];
  selectedModelLabel: string;
  selectedModelValue: string;
  selectedThinkingLabel: string;
  selectedThinkingValue: string;
  thinkingDisabled: boolean;
  thinkingOptions: ChatInlineSelectOption[];
  onFastModeSelect: (value: "" | "on" | "off") => Promise<unknown>;
  onModelSelect: (value: string) => Promise<unknown>;
  onThinkingSelect: (value: string) => Promise<unknown>;
}) {
  const {
    disabled,
    fastMode,
    modelOptions,
    selectedModelLabel,
    selectedModelValue,
    selectedThinkingLabel,
    selectedThinkingValue,
    thinkingDisabled,
    thinkingOptions,
    onFastModeSelect,
    onModelSelect,
    onThinkingSelect,
  } = params;
  const triggerModel = formatCombinedPickerModelLabel(selectedModelLabel);
  const triggerThinking = formatCombinedPickerThinkingLabel(selectedThinkingLabel);
  const triggerLabel = `${triggerModel} · ${triggerThinking}`;
  return html`
    <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
      <summary
        class="chat-controls__inline-select-trigger ${disabled
          ? "chat-controls__inline-select-trigger--disabled"
          : ""}"
        data-chat-model-select="true"
        data-chat-thinking-select="true"
        data-chat-select-value=${selectedModelValue}
        data-chat-thinking-value=${selectedThinkingValue}
        data-chat-thinking-disabled=${thinkingDisabled ? "true" : "false"}
        aria-label=${`${t("chat.selectors.model")}, ${t("chat.selectors.thinkingLevel")}: ${triggerLabel}`}
        aria-disabled=${disabled ? "true" : "false"}
        title=${triggerLabel}
        @click=${(event: MouseEvent) => {
          if (disabled) {
            event.preventDefault();
          }
        }}
      >
        <span class="chat-controls__inline-select-label">${triggerLabel}</span>
        <span class="chat-controls__inline-select-icon" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </summary>
      <div
        class="chat-controls__inline-select-menu chat-controls__inline-select-menu--combined"
        aria-label=${t("chat.selectors.model")}
      >
        <div class="chat-controls__inline-select-section-label">Model</div>
        <div class="chat-controls__combined-model-list">
          ${repeat(
            modelOptions,
            (entry) => entry.value,
            (entry) => {
              const selected = entry.value === selectedModelValue;
              return html`
                <div class="chat-controls__combined-model">
                  <button
                    class="chat-controls__inline-select-option chat-controls__combined-model-option ${selected
                      ? "chat-controls__inline-select-option--selected"
                      : ""}"
                    data-chat-model-option=${entry.value}
                    role="option"
                    aria-selected=${selected ? "true" : "false"}
                    type="button"
                    ?disabled=${disabled}
                    @click=${async (event: MouseEvent) => {
                      if (disabled || selected) {
                        event.preventDefault();
                        return;
                      }
                      (event.currentTarget as HTMLElement)
                        .closest("details")
                        ?.removeAttribute("open");
                      await onModelSelect(entry.value);
                    }}
                  >
                    <span>${formatCombinedPickerModelOptionLabel(entry, selected)}</span>
                    ${selected
                      ? html`<span
                          class="chat-controls__inline-select-check chat-controls__combined-model-arrow"
                          aria-hidden="true"
                        >
                          ${icons.chevronDown}
                        </span>`
                      : ""}
                  </button>
                </div>
              `;
            },
          )}
        </div>
        <div
          class="chat-controls__reasoning-panel"
          role="listbox"
          aria-label=${t("chat.selectors.thinkingLevel")}
        >
          <div class="chat-controls__inline-select-section-label">Reasoning</div>
          <div class="chat-controls__reasoning-options">
            ${repeat(
              thinkingOptions,
              (thinking) => thinking.value,
              (thinking) => {
                const thinkingSelected = thinking.value === selectedThinkingValue;
                return html`
                  <button
                    class="chat-controls__reasoning-option ${thinkingSelected
                      ? "chat-controls__reasoning-option--selected"
                      : ""}"
                    data-chat-thinking-option=${thinking.value}
                    role="option"
                    aria-selected=${thinkingSelected ? "true" : "false"}
                    type="button"
                    ?disabled=${thinkingDisabled}
                    @click=${async (event: MouseEvent) => {
                      event.stopPropagation();
                      if (thinkingDisabled) {
                        event.preventDefault();
                        return;
                      }
                      (event.currentTarget as HTMLElement)
                        .closest("details")
                        ?.removeAttribute("open");
                      await onThinkingSelect(thinking.value);
                    }}
                  >
                    <span>${formatCombinedPickerThinkingOptionLabel(thinking)}</span>
                    ${thinkingSelected
                      ? html`<span class="chat-controls__inline-select-check" aria-hidden="true">
                          ${icons.check}
                        </span>`
                      : ""}
                  </button>
                `;
              },
            )}
          </div>
          ${fastMode.supported
            ? html`
                <div class="chat-controls__inline-select-section-label">Speed</div>
                <div class="chat-controls__reasoning-options" role="listbox">
                  ${repeat(
                    fastMode.options,
                    (speed) => speed.value,
                    (speed) => {
                      const speedValue = speed.value as "" | "on" | "off";
                      const speedSelected = speedValue === fastMode.currentOverride;
                      return html`
                        <button
                          class="chat-controls__reasoning-option ${speedSelected
                            ? "chat-controls__reasoning-option--selected"
                            : ""}"
                          data-chat-speed-option=${speed.value}
                          role="option"
                          aria-selected=${speedSelected ? "true" : "false"}
                          type="button"
                          ?disabled=${fastMode.disabled}
                          @click=${async (event: MouseEvent) => {
                            event.stopPropagation();
                            if (fastMode.disabled) {
                              event.preventDefault();
                              return;
                            }
                            (event.currentTarget as HTMLElement)
                              .closest("details")
                              ?.removeAttribute("open");
                            await onFastModeSelect(speedValue);
                          }}
                        >
                          <span>${speed.label}</span>
                          ${speedSelected
                            ? html`<span
                                class="chat-controls__inline-select-check"
                                aria-hidden="true"
                              >
                                ${icons.check}
                              </span>`
                            : ""}
                        </button>
                      `;
                    },
                  )}
                </div>
              `
            : ""}
        </div>
      </div>
    </details>
  `;
}

function patchSessionFastMode(
  state: AppViewState,
  sessionKey: string,
  fastMode: boolean | undefined,
) {
  const current = state.sessionsResult;
  if (!current) {
    return;
  }
  state.sessionsResult = {
    ...current,
    sessions: current.sessions.map((row) =>
      row.key === sessionKey ? Object.assign({}, row, { fastMode }) : row,
    ),
  };
}

async function switchChatFastMode(state: AppViewState, nextFastMode: "" | "on" | "off") {
  if (!state.client || !state.connected) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === targetSessionKey);
  const previousFastMode = activeRow?.fastMode;
  const next = nextFastMode === "" ? undefined : nextFastMode === "on";
  if (previousFastMode === next) {
    return;
  }
  setChatError(state, null);
  patchSessionFastMode(state, targetSessionKey, next);
  try {
    await state.client.request("sessions.patch", {
      key: targetSessionKey,
      ...scopedAgentParamsForSession(state, targetSessionKey),
      fastMode: next ?? null,
    });
    await refreshSessionOptions(state);
    patchSessionFastMode(state, targetSessionKey, next);
  } catch (err) {
    patchSessionFastMode(state, targetSessionKey, previousFastMode);
    setChatError(state, `Failed to set speed: ${String(err)}`);
  }
}

async function switchChatModel(state: AppViewState, nextModel: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const currentOverride = resolveChatModelOverrideValue(state);
  if (currentOverride === nextModel) {
    return true;
  }
  const targetSessionKey = state.sessionKey;
  const prevOverride = state.chatModelOverrides[targetSessionKey];
  setChatError(state, null);
  // Write the override cache immediately so the picker stays in sync during the RPC round-trip.
  state.chatModelOverrides = {
    ...state.chatModelOverrides,
    [targetSessionKey]: createChatModelOverride(nextModel),
  };
  const client = state.client;
  const switchPromiseRef: { current?: Promise<boolean> } = {};
  const clearPendingSwitch = () => {
    if (state.chatModelSwitchPromises?.[targetSessionKey] === switchPromiseRef.current) {
      const nextSwitches = { ...state.chatModelSwitchPromises };
      delete nextSwitches[targetSessionKey];
      state.chatModelSwitchPromises = nextSwitches;
    }
  };
  const switchPromise: Promise<boolean> = (async () => {
    try {
      await client.request("sessions.patch", {
        key: targetSessionKey,
        ...scopedAgentParamsForSession(state, targetSessionKey),
        model: nextModel || null,
      });
      void refreshVisibleToolsEffectiveForCurrentSessionLazy(state);
      await refreshSessionOptions(state);
      return true;
    } catch (err) {
      // Roll back so the picker reflects the actual server model.
      state.chatModelOverrides = { ...state.chatModelOverrides, [targetSessionKey]: prevOverride };
      setChatError(state, `Failed to set model: ${String(err)}`);
      return false;
    } finally {
      clearPendingSwitch();
    }
  })();
  switchPromiseRef.current = switchPromise;
  state.chatModelSwitchPromises = {
    ...state.chatModelSwitchPromises,
    [targetSessionKey]: switchPromise,
  };
  return switchPromise;
}

function patchSessionThinkingLevel(
  state: AppViewState,
  sessionKey: string,
  thinkingLevel: string | undefined,
) {
  const current = state.sessionsResult;
  if (!current) {
    return;
  }
  state.sessionsResult = {
    ...current,
    sessions: current.sessions.map((row) =>
      row.key === sessionKey ? Object.assign({}, row, { thinkingLevel }) : row,
    ),
  };
}

async function switchChatThinkingLevel(state: AppViewState, nextThinkingLevel: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === targetSessionKey);
  const previousThinkingLevel = activeRow?.thinkingLevel;
  const normalizedNext =
    (normalizeThinkLevel(nextThinkingLevel) ?? nextThinkingLevel.trim()) || undefined;
  const normalizedPrev =
    typeof previousThinkingLevel === "string" && previousThinkingLevel.trim()
      ? (normalizeThinkLevel(previousThinkingLevel) ?? previousThinkingLevel.trim())
      : undefined;
  if ((normalizedPrev ?? "") === (normalizedNext ?? "")) {
    return;
  }
  setChatError(state, null);
  patchSessionThinkingLevel(state, targetSessionKey, normalizedNext);
  state.chatThinkingLevel = normalizedNext ?? null;
  try {
    await state.client.request("sessions.patch", {
      key: targetSessionKey,
      ...scopedAgentParamsForSession(state, targetSessionKey),
      thinkingLevel: normalizedNext ?? null,
    });
    await refreshSessionOptions(state);
    patchSessionThinkingLevel(state, targetSessionKey, normalizedNext);
    state.chatThinkingLevel = normalizedNext ?? null;
  } catch (err) {
    patchSessionThinkingLevel(state, targetSessionKey, previousThinkingLevel);
    state.chatThinkingLevel = normalizedPrev ?? null;
    setChatError(state, `Failed to set thinking level: ${String(err)}`);
  }
}

type SessionOptionEntry = {
  key: string;
  label: string;
  scopeLabel: string;
  title: string;
};

export type SessionOptionGroup = {
  id: string;
  label: string;
  options: SessionOptionEntry[];
};

type ChatAgentFilterOption = {
  id: string;
  label: string;
};

export function resolveChatAgentFilterId(state: AppViewState, sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? state.agentsList?.defaultId ?? "main");
}

function resolvePreferredSessionCandidateAgentId(
  row: SessionsListResult["sessions"][number],
  defaultAgentId: string,
): string | null {
  if (row.kind === "global" || row.kind === "unknown" || isCronSessionKey(row.key)) {
    return null;
  }
  if (isSubagentSessionKey(row.key) || row.spawnedBy) {
    return null;
  }
  const parsed = parseAgentSessionKey(row.key);
  return normalizeAgentId(parsed?.agentId ?? defaultAgentId);
}

function rememberChatAgentSessionRows(
  state: AppViewState,
  sessions: SessionsListResult | null,
): void {
  if (!sessions) {
    return;
  }
  const rows = sessions.sessions;
  const refreshedAgentId = normalizeOptionalString(state.sessionsResultAgentId);
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const grouped = new Map<string, SessionsListResult["sessions"]>();
  for (const row of rows) {
    const agentId = resolvePreferredSessionCandidateAgentId(row, defaultAgentId);
    if (!agentId) {
      continue;
    }
    grouped.set(agentId, [...(grouped.get(agentId) ?? []), row]);
  }
  if (grouped.size === 0 && !refreshedAgentId) {
    return;
  }
  state.chatAgentSessionRowsByAgent ??= {};
  if (refreshedAgentId) {
    state.chatAgentSessionRowsByAgent[refreshedAgentId] = grouped.get(refreshedAgentId) ?? [];
  }
  for (const [agentId, agentRows] of grouped) {
    state.chatAgentSessionRowsByAgent[agentId] = agentRows;
  }
}

function rowsForPreferredAgentSession(
  state: AppViewState,
  normalizedAgentId: string,
  defaultAgentId: string,
): SessionsListResult["sessions"] {
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of state.chatAgentSessionRowsByAgent?.[normalizedAgentId] ?? []) {
    byKey.set(row.key, row);
  }
  for (const row of state.sessionsResult?.sessions ?? []) {
    if (resolvePreferredSessionCandidateAgentId(row, defaultAgentId) === normalizedAgentId) {
      byKey.set(row.key, row);
    }
  }
  return [...byKey.values()];
}

export function resolvePreferredSessionForAgent(state: AppViewState, agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (resolveChatAgentFilterId(state, state.sessionKey) === normalizedAgentId) {
    return state.sessionKey;
  }
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const eligible = rowsForPreferredAgentSession(state, normalizedAgentId, defaultAgentId)
    .filter((row) => {
      if (!isSessionKeyTiedToAgent(row.key, normalizedAgentId, defaultAgentId)) {
        return false;
      }
      return resolvePreferredSessionCandidateAgentId(row, defaultAgentId) === normalizedAgentId;
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (eligible[0]?.key) {
    return eligible[0].key;
  }
  return buildAgentMainSessionKey({ agentId: normalizedAgentId });
}

export function resolveChatAgentFilterOptions(state: AppViewState): ChatAgentFilterOption[] {
  const seen = new Set<string>();
  const options: ChatAgentFilterOption[] = [];
  const add = (agentId: string) => {
    const normalized = normalizeAgentId(agentId);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    options.push({
      id: normalized,
      label: resolveAgentGroupLabel(state, normalized),
    });
  };

  add(resolveChatAgentFilterId(state, state.sessionKey));
  add(state.agentsList?.defaultId ?? "main");
  for (const agent of state.agentsList?.agents ?? []) {
    add(agent.id);
  }
  for (const row of state.sessionsResult?.sessions ?? []) {
    const parsed = parseAgentSessionKey(row.key);
    if (parsed) {
      add(parsed.agentId);
    }
  }

  return options;
}

export function resolveSessionOptionGroups(
  state: AppViewState,
  sessionKey: string,
  sessions: SessionsListResult | null,
): SessionOptionGroup[] {
  const rows = sessions?.sessions ?? [];
  const hideCron = state.sessionsHideCron ?? true;
  const activeAgentId = resolveChatAgentFilterId(state, sessionKey);
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of rows) {
    byKey.set(row.key, row);
  }

  const seenKeys = new Set<string>();
  const groups = new Map<string, SessionOptionGroup>();
  const ensureGroup = (groupId: string, label: string): SessionOptionGroup => {
    const existing = groups.get(groupId);
    if (existing) {
      return existing;
    }
    const created: SessionOptionGroup = {
      id: groupId,
      label,
      options: [],
    };
    groups.set(groupId, created);
    return created;
  };

  const addOption = (key: string) => {
    if (!key || seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    const row = byKey.get(key);
    const parsed = parseAgentSessionKey(key);
    const group = parsed
      ? ensureGroup(
          `agent:${normalizeLowercaseStringOrEmpty(parsed.agentId)}`,
          resolveAgentGroupLabel(state, parsed.agentId),
        )
      : ensureGroup("other", "Other Sessions");
    const scopeLabel = normalizeOptionalString(parsed?.rest) ?? key;
    group.options.push({
      key,
      label: resolveSessionScopedOptionLabel(key, row, parsed?.rest),
      scopeLabel,
      title: key,
    });
  };

  for (const row of rows) {
    if (
      !isSessionKeyTiedToAgent(row.key, activeAgentId, defaultAgentId) &&
      row.key !== sessionKey
    ) {
      continue;
    }
    if (row.key !== sessionKey && (row.kind === "global" || row.kind === "unknown")) {
      continue;
    }
    if (hideCron && row.key !== sessionKey && isCronSessionKey(row.key)) {
      continue;
    }
    const isSubagent = isSubagentSessionKey(row.key) || Boolean(row.spawnedBy);
    if (isSubagent && row.key !== sessionKey) {
      continue;
    }
    addOption(row.key);
  }
  if (byKey.has(sessionKey)) {
    addOption(sessionKey);
  } else if (sessionKey) {
    addOption(sessionKey);
  }

  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    for (const option of group.options) {
      counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
    }
    for (const option of group.options) {
      if ((counts.get(option.label) ?? 0) > 1 && option.scopeLabel !== option.label) {
        option.label = `${option.label} · ${option.scopeLabel}`;
      }
    }
  }

  const allOptions = Array.from(groups.values()).flatMap((group) =>
    group.options.map((option) => ({ groupLabel: group.label, option })),
  );
  const labels = new Map(allOptions.map(({ option }) => [option, option.label]));
  const countAssignedLabels = () => {
    const counts = new Map<string, number>();
    for (const { option } of allOptions) {
      const label = labels.get(option) ?? option.label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  };
  const labelIncludesScopeLabel = (label: string, scopeLabel: string) => {
    const trimmedScope = scopeLabel.trim();
    if (!trimmedScope) {
      return false;
    }
    return (
      label === trimmedScope ||
      label.endsWith(` · ${trimmedScope}`) ||
      label.endsWith(` / ${trimmedScope}`)
    );
  };

  const globalCounts = countAssignedLabels();
  for (const { groupLabel, option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((globalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    const scopedPrefix = `${groupLabel} / `;
    if (currentLabel.startsWith(scopedPrefix)) {
      continue;
    }
    // Keep the agent visible once the native select collapses to a single chosen label.
    labels.set(option, `${groupLabel} / ${currentLabel}`);
  }

  const scopedCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((scopedCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    if (labelIncludesScopeLabel(currentLabel, option.scopeLabel)) {
      continue;
    }
    labels.set(option, `${currentLabel} · ${option.scopeLabel}`);
  }

  const finalCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((finalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    // Fall back to the full key only when every friendlier disambiguator still collides.
    labels.set(option, `${currentLabel} · ${option.key}`);
  }

  for (const { option } of allOptions) {
    option.label = labels.get(option) ?? option.label;
  }

  return Array.from(groups.values());
}

function resolveAgentGroupLabel(state: AppViewState, agentIdRaw: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(agentIdRaw);
  const agent = (state.agentsList?.agents ?? []).find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === normalized,
  );
  const name =
    normalizeOptionalString(agent?.identity?.name) ?? normalizeOptionalString(agent?.name) ?? "";
  return name && name !== agentIdRaw ? `${name} (${agentIdRaw})` : agentIdRaw;
}

function resolveSessionScopedOptionLabel(
  key: string,
  row?: SessionsListResult["sessions"][number],
  rest?: string,
) {
  const base = normalizeOptionalString(rest) ?? key;
  if (!row) {
    return base;
  }

  const label = normalizeOptionalString(row.label) ?? "";
  const displayName = normalizeOptionalString(row.displayName) ?? "";
  if ((label && label !== key) || (displayName && displayName !== key)) {
    return resolveSessionDisplayName(key, row);
  }

  return base;
}
