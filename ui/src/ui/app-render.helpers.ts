import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../i18n/index.ts";
import { refreshChat, refreshChatAvatar } from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { createChatModelOverride } from "./chat-model-ref.ts";
import {
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./chat-model-select-state.ts";
import { refreshSlashCommands } from "./chat/slash-commands.ts";
import { refreshVisibleToolsEffectiveForCurrentSession } from "./controllers/agents.ts";
import { ChatState, loadChatHistory } from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";
import { parseAgentSessionKey } from "./session-key.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "./string-coerce.ts";
import type { ThemeMode } from "./theme.ts";
import {
  listThinkingLevelLabels,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
} from "./thinking.ts";
import type { SessionsListResult } from "./types.ts";

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
};

type SessionSwitchHost = AppViewState & {
  chatStreamStartedAt: number | null;
  chatSideResultTerminalRuns: Set<string>;
  resetToolStream(): void;
  resetChatScroll(): void;
};

type ChatRefreshHost = AppViewState & {
  chatManualRefreshInFlight: boolean;
  chatNewMessagesBelow: boolean;
  resetToolStream(): void;
  scrollToBottom(opts?: { smooth?: boolean }): void;
  updateComplete?: Promise<unknown>;
};

export function resolveAssistantAttachmentAuthToken(
  state: Pick<AppViewState, "settings" | "password">,
) {
  return (
    normalizeOptionalString(state.settings.token) ?? normalizeOptionalString(state.password) ?? null
  );
}

function resolveSidebarChatSessionKey(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const mainSessionKey = normalizeOptionalString(snapshot?.sessionDefaults?.mainSessionKey);
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = normalizeOptionalString(snapshot?.sessionDefaults?.mainKey);
  if (mainKey) {
    return mainKey;
  }
  return "main";
}

function resetChatStateForSessionSwitch(state: AppViewState, sessionKey: string) {
  const host = state as unknown as SessionSwitchHost;
  state.sessionKey = sessionKey;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatMessages = [];
  state.chatToolMessages = [];
  state.chatStreamSegments = [];
  state.chatThinkingLevel = null;
  state.chatStream = null;
  state.chatSideResult = null;
  state.lastError = null;
  state.compactionStatus = null;
  state.fallbackStatus = null;
  state.chatAvatarUrl = null;
  state.chatQueue = [];
  host.chatStreamStartedAt = null;
  state.chatRunId = null;
  host.chatSideResultTerminalRuns.clear();
  host.resetToolStream();
  host.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

export function renderTab(state: AppViewState, tab: Tab, opts?: { collapsed?: boolean }) {
  const href = pathForTab(tab, state.basePath);
  const isActive = state.tab === tab;
  const collapsed = opts?.collapsed ?? state.settings.navCollapsed;
  return html`
    <a
      href=${href}
      class="nav-item ${isActive ? "nav-item--active" : ""}"
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
        if (tab === "chat") {
          const mainSessionKey = resolveSidebarChatSessionKey(state);
          if (state.sessionKey !== mainSessionKey) {
            resetChatStateForSessionSwitch(state, mainSessionKey);
            void state.loadAssistantIdentity();
          }
        }
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      ${!collapsed ? html`<span class="nav-item__text">${titleForTab(tab)}</span>` : nothing}
    </a>
  `;
}

function renderCronFilterIcon(hiddenCount: number) {
  return html`
    <span style="position: relative; display: inline-flex; align-items: center;">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
      ${hiddenCount > 0
        ? html`<span
            style="
              position: absolute;
              top: -5px;
              right: -6px;
              background: var(--color-accent, #6366f1);
              color: #fff;
              border-radius: var(--radius-full);
              font-size: 9px;
              line-height: 1;
              padding: 1px 3px;
              pointer-events: none;
            "
            >${hiddenCount}</span
          >`
        : ""}
    </span>
  `;
}

export function renderChatSessionSelect(state: AppViewState) {
  const sessionGroups = resolveSessionOptionGroups(state, state.sessionKey, state.sessionsResult);
  const modelSelect = renderChatModelSelect(state);
  const thinkingSelect = renderChatThinkingSelect(state);
  const selectedSessionLabel =
    sessionGroups.flatMap((group) => group.options).find((entry) => entry.key === state.sessionKey)
      ?.label ?? state.sessionKey;
  return html`
    <div class="chat-controls__session-row">
      <label class="field chat-controls__session">
        <select
          .value=${state.sessionKey}
          title=${selectedSessionLabel}
          ?disabled=${!state.connected || sessionGroups.length === 0}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value;
            if (state.sessionKey === next) {
              return;
            }
            switchChatSession(state, next);
          }}
        >
          ${repeat(
            sessionGroups,
            (group) => group.id,
            (group) =>
              html`<optgroup label=${group.label}>
                ${repeat(
                  group.options,
                  (entry) => entry.key,
                  (entry) =>
                    html`<option value=${entry.key} title=${entry.title}>${entry.label}</option>`,
                )}
              </optgroup>`,
          )}
        </select>
      </label>
      ${modelSelect} ${thinkingSelect}
    </div>
  `;
}

export function renderChatControls(state: AppViewState) {
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron
    ? countHiddenCronSessions(state.sessionKey, state.sessionsResult)
    : 0;
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  const toolCallsIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;
  const refreshIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
      <path d="M21 3v5h-5"></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
  return html`
    <div class="chat-controls">
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${state.chatLoading || !state.connected}
        @click=${async () => {
          const app = state as unknown as ChatRefreshHost;
          app.chatManualRefreshInFlight = true;
          app.chatNewMessagesBelow = false;
          await app.updateComplete;
          app.resetToolStream();
          try {
            await refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
              scheduleScroll: false,
            });
            app.scrollToBottom({ smooth: true });
          } finally {
            requestAnimationFrame(() => {
              app.chatManualRefreshInFlight = false;
              app.chatNewMessagesBelow = false;
            });
          }
        }}
        title=${t("chat.refreshTitle")}
      >
        ${refreshIcon}
      </button>
      <span class="chat-controls__separator">|</span>
      <button
        class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowThinking: !state.settings.chatShowThinking,
          });
        }}
        aria-pressed=${showThinking}
        title=${disableThinkingToggle ? t("chat.onboardingDisabled") : t("chat.thinkingToggle")}
      >
        ${icons.brain}
      </button>
      <button
        class="btn btn--sm btn--icon ${showToolCalls ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowToolCalls: !state.settings.chatShowToolCalls,
          });
        }}
        aria-pressed=${showToolCalls}
        title=${disableThinkingToggle ? t("chat.onboardingDisabled") : t("chat.toolCallsToggle")}
      >
        ${toolCallsIcon}
      </button>
      <button
        class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
        ?disabled=${disableFocusToggle}
        @click=${() => {
          if (disableFocusToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatFocusMode: !state.settings.chatFocusMode,
          });
        }}
        aria-pressed=${focusActive}
        title=${disableFocusToggle ? t("chat.onboardingDisabled") : t("chat.focusToggle")}
      >
        ${focusIcon}
      </button>
      <button
        class="btn btn--sm btn--icon ${hideCron ? "active" : ""}"
        @click=${() => {
          state.sessionsHideCron = !hideCron;
        }}
        aria-pressed=${hideCron}
        title=${hideCron
          ? hiddenCronCount > 0
            ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
            : t("chat.showCronSessions")
          : t("chat.hideCronSessions")}
      >
        ${renderCronFilterIcon(hiddenCronCount)}
      </button>
    </div>
  `;
}

/**
 * Mobile-only gear toggle + dropdown for chat controls.
 * Rendered in the topbar so it doesn't consume content-header space.
 * Hidden on desktop via CSS.
 */
export function renderChatMobileToggle(state: AppViewState) {
  const sessionGroups = resolveSessionOptionGroups(state, state.sessionKey, state.sessionsResult);
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  const toolCallsIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;

  return html`
    <div class="chat-mobile-controls-wrapper">
      <button
        class="btn btn--sm btn--icon chat-controls-mobile-toggle"
        @click=${(e: Event) => {
          e.stopPropagation();
          const btn = e.currentTarget as HTMLElement;
          const dropdown = btn.nextElementSibling as HTMLElement;
          if (dropdown) {
            const isOpen = dropdown.classList.toggle("open");
            if (isOpen) {
              const close = () => {
                dropdown.classList.remove("open");
                document.removeEventListener("click", close);
              };
              setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
            }
          }
        }}
        title="Chat settings"
        aria-label="Chat settings"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3"></circle>
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          ></path>
        </svg>
      </button>
      <div
        class="chat-controls-dropdown"
        @click=${(e: Event) => {
          e.stopPropagation();
        }}
      >
        <div class="chat-controls">
          <label class="field chat-controls__session">
            <select
              .value=${state.sessionKey}
              @change=${(e: Event) => {
                const next = (e.target as HTMLSelectElement).value;
                switchChatSession(state, next);
              }}
            >
              ${sessionGroups.map(
                (group) => html`
                  <optgroup label=${group.label}>
                    ${group.options.map(
                      (opt) => html`
                        <option value=${opt.key} title=${opt.title}>${opt.label}</option>
                      `,
                    )}
                  </optgroup>
                `,
              )}
            </select>
          </label>
          ${renderChatThinkingSelect(state)}
          <div class="chat-controls__thinking">
            <button
              class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowThinking: !state.settings.chatShowThinking,
                  });
                }
              }}
              aria-pressed=${showThinking}
              title=${t("chat.thinkingToggle")}
            >
              ${icons.brain}
            </button>
            <button
              class="btn btn--sm btn--icon ${showToolCalls ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowToolCalls: !state.settings.chatShowToolCalls,
                  });
                }
              }}
              aria-pressed=${showToolCalls}
              title=${t("chat.toolCallsToggle")}
            >
              ${toolCallsIcon}
            </button>
            <button
              class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
              ?disabled=${disableFocusToggle}
              @click=${() => {
                if (!disableFocusToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatFocusMode: !state.settings.chatFocusMode,
                  });
                }
              }}
              aria-pressed=${focusActive}
              title=${t("chat.focusToggle")}
            >
              ${focusIcon}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function switchChatSession(state: AppViewState, nextSessionKey: string) {
  resetChatStateForSessionSwitch(state, nextSessionKey);
  void state.loadAssistantIdentity();
  void refreshChatAvatar(state);
  void refreshSlashCommands({
    client: state.client,
    agentId: parseAgentSessionKey(nextSessionKey)?.agentId,
  });
  syncUrlWithSessionKey(
    state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
    nextSessionKey,
    true,
  );
  void loadChatHistory(state as unknown as ChatState);
  void refreshSessionOptions(state);
}

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    activeMinutes: 0,
    limit: 0,
    includeGlobal: true,
    includeUnknown: true,
  });
}

function renderChatModelSelect(state: AppViewState) {
  const { currentOverride, defaultLabel, options } = resolveChatModelSelectState(state);
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const disabled =
    !state.connected || busy || (state.chatModelsLoading && options.length === 0) || !state.client;
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (options.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  return html`
    <label class="field chat-controls__session chat-controls__model">
      <select
        data-chat-model-select="true"
        aria-label="Chat model"
        title=${selectedLabel}
        ?disabled=${disabled}
        @change=${async (e: Event) => {
          const next = (e.target as HTMLSelectElement).value.trim();
          await switchChatModel(state, next);
        }}
      >
        <option value="" ?selected=${currentOverride === ""}>${defaultLabel}</option>
        ${repeat(
          options,
          (entry) => entry.value,
          (entry) =>
            html`<option value=${entry.value} ?selected=${entry.value === currentOverride}>
              ${entry.label}
            </option>`,
        )}
      </select>
    </label>
  `;
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

function buildThinkingOptions(
  provider: string | null,
  model: string | null,
  currentOverride: string,
): ChatThinkingSelectOption[] {
  const seen = new Set<string>();
  const options: ChatThinkingSelectOption[] = [];

  const addOption = (value: string, label?: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const key = normalizeLowercaseStringOrEmpty(trimmed);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push({
      value: trimmed,
      label:
        label ??
        trimmed
          .split(/[-_]/g)
          .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
          .join(" "),
    });
  };

  for (const label of listThinkingLevelLabels(provider)) {
    const normalized = normalizeThinkLevel(label) ?? normalizeLowercaseStringOrEmpty(label);
    addOption(normalized);
  }
  if (currentOverride) {
    addOption(currentOverride);
  }
  return options;
}

function resolveChatThinkingSelectState(state: AppViewState): ChatThinkingSelectState {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const persisted = activeRow?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const { provider, model } = resolveThinkingTargetModel(state);
  const defaultLevel =
    provider && model
      ? resolveThinkingDefaultForModel({
          provider,
          model,
          catalog: state.chatModelCatalog ?? [],
        })
      : "off";
  return {
    currentOverride,
    defaultLabel: `Default (${defaultLevel})`,
    options: buildThinkingOptions(provider, model, currentOverride),
  };
}

function renderChatThinkingSelect(state: AppViewState) {
  const { currentOverride, defaultLabel, options } = resolveChatThinkingSelectState(state);
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const disabled = !state.connected || busy || !state.client;
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (options.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  return html`
    <label class="field chat-controls__session chat-controls__thinking-select">
      <select
        data-chat-thinking-select="true"
        aria-label="Chat thinking level"
        title=${selectedLabel}
        ?disabled=${disabled}
        @change=${async (e: Event) => {
          const next = (e.target as HTMLSelectElement).value.trim();
          await switchChatThinkingLevel(state, next);
        }}
      >
        <option value="" ?selected=${currentOverride === ""}>${defaultLabel}</option>
        ${repeat(
          options,
          (entry) => entry.value,
          (entry) =>
            html`<option value=${entry.value} ?selected=${entry.value === currentOverride}>
              ${entry.label}
            </option>`,
        )}
      </select>
    </label>
  `;
}

async function switchChatModel(state: AppViewState, nextModel: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const currentOverride = resolveChatModelOverrideValue(state);
  if (currentOverride === nextModel) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const prevOverride = state.chatModelOverrides[targetSessionKey];
  state.lastError = null;
  // Write the override cache immediately so the picker stays in sync during the RPC round-trip.
  state.chatModelOverrides = {
    ...state.chatModelOverrides,
    [targetSessionKey]: createChatModelOverride(nextModel),
  };
  try {
    await state.client.request("sessions.patch", {
      key: targetSessionKey,
      model: nextModel || null,
    });
    void refreshVisibleToolsEffectiveForCurrentSession(state);
    await refreshSessionOptions(state);
  } catch (err) {
    // Roll back so the picker reflects the actual server model.
    state.chatModelOverrides = { ...state.chatModelOverrides, [targetSessionKey]: prevOverride };
    state.lastError = `Failed to set model: ${String(err)}`;
  }
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
      row.key === sessionKey
        ? {
            ...row,
            thinkingLevel,
          }
        : row,
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
  state.lastError = null;
  patchSessionThinkingLevel(state, targetSessionKey, normalizedNext);
  state.chatThinkingLevel = normalizedNext ?? null;
  try {
    await state.client.request("sessions.patch", {
      key: targetSessionKey,
      thinkingLevel: normalizedNext ?? null,
    });
    await refreshSessionOptions(state);
  } catch (err) {
    patchSessionThinkingLevel(state, targetSessionKey, previousThinkingLevel);
    state.chatThinkingLevel = normalizedPrev ?? null;
    state.lastError = `Failed to set thinking level: ${String(err)}`;
  }
}

/* ── Channel display labels ────────────────────────────── */
const CHANNEL_LABELS: Record<string, string> = {
  bluebubbles: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
};

const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

/** Parsed type / context extracted from a session key. */
export type SessionKeyInfo = {
  /** Prefix for typed sessions (Subagent:/Cron:). Empty for others. */
  prefix: string;
  /** Human-readable fallback when no label / displayName is available. */
  fallbackName: string;
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse a session key to extract type information and a human-readable
 * fallback display name.  Exported for testing.
 */
export function parseSessionKey(key: string): SessionKeyInfo {
  const normalized = normalizeLowercaseStringOrEmpty(key);

  // ── Main session ─────────────────────────────────
  if (key === "main" || key === "agent:main:main") {
    return { prefix: "", fallbackName: "Main Session" };
  }

  // ── Subagent ─────────────────────────────────────
  if (key.includes(":subagent:")) {
    return { prefix: "Subagent:", fallbackName: "Subagent:" };
  }

  // ── Cron job ─────────────────────────────────────
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    return { prefix: "Cron:", fallbackName: "Cron Job:" };
  }

  // ── Direct chat  (agent:<x>:<channel>:direct:<id>) ──
  const directMatch = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (directMatch) {
    const channel = directMatch[1];
    const identifier = directMatch[2];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} · ${identifier}` };
  }

  // ── Group chat  (agent:<x>:<channel>:group:<id>) ────
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    const channel = groupMatch[1];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} Group` };
  }

  // ── Channel-prefixed legacy keys (e.g. "bluebubbles:g-…") ──
  for (const ch of KNOWN_CHANNEL_KEYS) {
    if (key === ch || key.startsWith(`${ch}:`)) {
      return { prefix: "", fallbackName: `${CHANNEL_LABELS[ch]} Session` };
    }
  }

  // ── Unknown — return key as-is ───────────────────
  return { prefix: "", fallbackName: key };
}

export function resolveSessionDisplayName(
  key: string,
  row?: SessionsListResult["sessions"][number],
): string {
  const label = normalizeOptionalString(row?.label) ?? "";
  const displayName = normalizeOptionalString(row?.displayName) ?? "";
  const { prefix, fallbackName } = parseSessionKey(key);

  const applyTypedPrefix = (name: string): string => {
    if (!prefix) {
      return name;
    }
    const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*`, "i");
    return prefixPattern.test(name) ? name : `${prefix} ${name}`;
  };

  if (label && label !== key) {
    return applyTypedPrefix(label);
  }
  if (displayName && displayName !== key) {
    return applyTypedPrefix(displayName);
  }
  return fallbackName;
}

export function isCronSessionKey(key: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(key);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("cron:")) {
    return true;
  }
  if (!normalized.startsWith("agent:")) {
    return false;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (parts.length < 3) {
    return false;
  }
  const rest = parts.slice(2).join(":");
  return rest.startsWith("cron:");
}

type SessionOptionEntry = {
  key: string;
  label: string;
  scopeLabel: string;
  title: string;
};

type SessionOptionGroup = {
  id: string;
  label: string;
  options: SessionOptionEntry[];
};

export function resolveSessionOptionGroups(
  state: AppViewState,
  sessionKey: string,
  sessions: SessionsListResult | null,
): SessionOptionGroup[] {
  const rows = sessions?.sessions ?? [];
  const hideCron = state.sessionsHideCron ?? true;
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
    const label = resolveSessionScopedOptionLabel(key, row, parsed?.rest);
    group.options.push({
      key,
      label,
      scopeLabel,
      title: key,
    });
  };

  for (const row of rows) {
    if (row.key !== sessionKey && (row.kind === "global" || row.kind === "unknown")) {
      continue;
    }
    if (hideCron && row.key !== sessionKey && isCronSessionKey(row.key)) {
      continue;
    }
    addOption(row.key);
  }
  addOption(sessionKey);

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

/** Count sessions with a cron: key that would be hidden when hideCron=true. */
function countHiddenCronSessions(sessionKey: string, sessions: SessionsListResult | null): number {
  if (!sessions?.sessions) {
    return 0;
  }
  // Don't count the currently active session even if it's a cron.
  return sessions.sessions.filter((s) => isCronSessionKey(s.key) && s.key !== sessionKey).length;
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

type ThemeModeOption = { id: ThemeMode; label: string; short: string };
const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  { id: "system", label: "System", short: "SYS" },
  { id: "light", label: "Light", short: "LIGHT" },
  { id: "dark", label: "Dark", short: "DARK" },
];

export function renderTopbarThemeModeToggle(state: AppViewState) {
  const modeIcon = (mode: ThemeMode) => {
    if (mode === "system") {
      return icons.monitor;
    }
    if (mode === "light") {
      return icons.sun;
    }
    return icons.moon;
  };

  const applyMode = (mode: ThemeMode, e: Event) => {
    if (mode === state.themeMode) {
      return;
    }
    state.setThemeMode(mode, { element: e.currentTarget as HTMLElement });
  };

  return html`
    <div class="topbar-theme-mode" role="group" aria-label="Color mode">
      ${THEME_MODE_OPTIONS.map(
        (opt) => html`
          <button
            type="button"
            class="topbar-theme-mode__btn ${opt.id === state.themeMode
              ? "topbar-theme-mode__btn--active"
              : ""}"
            title=${opt.label}
            aria-label="Color mode: ${opt.label}"
            aria-pressed=${opt.id === state.themeMode}
            @click=${(e: Event) => applyMode(opt.id, e)}
          >
            ${modeIcon(opt.id)}
          </button>
        `,
      )}
    </div>
  `;
}

export function renderSidebarConnectionStatus(state: AppViewState) {
  const label = state.connected ? t("common.online") : t("common.offline");
  const toneClass = state.connected
    ? "sidebar-connection-status--online"
    : "sidebar-connection-status--offline";

  return html`
    <span
      class="sidebar-version__status ${toneClass}"
      role="img"
      aria-live="polite"
      aria-label="Gateway status: ${label}"
      title="Gateway status: ${label}"
    ></span>
  `;
}
