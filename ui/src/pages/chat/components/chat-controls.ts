// Chat-owned quota, settings, refresh, and display controls.
import { html } from "lit";
import type { AgentsListResult, SessionsListResult } from "../../../api/types.ts";
import {
  normalizeChatAutoScrollMode,
  normalizeChatSendShortcut,
  type ChatAutoScrollMode,
  type UiSettings,
} from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { isCronSessionKey } from "../../../lib/session-display.ts";
import {
  isSessionKeyTiedToAgent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../../lib/sessions/session-key.ts";
import type { RealtimeTalkInputDevice } from "../realtime-talk-input.ts";
import { renderChatModelControls, type ChatModelControlsProps } from "./chat-model-controls.ts";
import { renderRealtimeTalkOptions, type RealtimeTalkOptions } from "./chat-realtime-controls.ts";

type ChatControlsProps = {
  paneId: string;
  agentsList: AgentsListResult | null;
  connected: boolean;
  hideCronSessions: boolean;
  loading: boolean;
  manualRefreshInFlight: boolean;
  model: ChatModelControlsProps;
  onboarding: boolean;
  runId: string | null;
  sending: boolean;
  settings: UiSettings;
  settingsOpen: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  realtimeTalkOptions?: RealtimeTalkOptions;
  realtimeTalkInputDevices?: RealtimeTalkInputDevice[];
  realtimeTalkInputDeviceId?: string;
  realtimeTalkInputLoading?: boolean;
  realtimeTalkInputError?: string | null;
  canOpenRealtimeTalkSettings?: boolean;
  onOpenRealtimeTalkSettings?: () => void;
  onRefresh: () => Promise<void> | void;
  onRealtimeTalkInputRefresh?: () => void;
  onRealtimeTalkInputSelect?: (deviceId: string) => void;
  onRealtimeTalkOptionsChange?: (next: Partial<RealtimeTalkOptions>) => void;
  onSettingsChange: (next: UiSettings) => void;
  onSettingsOpenChange: (
    open: boolean,
    options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
  ) => void;
  onToggleCronSessions?: () => void;
};

function chatAutoScrollLabel(mode: ChatAutoScrollMode) {
  switch (mode) {
    case "always":
      return t("chat.autoScrollAlways");
    case "off":
      return t("chat.autoScrollOff");
    case "near-bottom":
      return t("chat.autoScrollNearBottom");
  }
  return t("chat.autoScrollNearBottom");
}

function nextChatAutoScrollMode(mode: ChatAutoScrollMode): ChatAutoScrollMode {
  switch (mode) {
    case "near-bottom":
      return "always";
    case "always":
      return "off";
    case "off":
      return "near-bottom";
  }
  return "near-bottom";
}

function renderChatAutoScrollToggle(props: {
  settings: UiSettings;
  onSettingsChange: (next: UiSettings) => void;
}) {
  const mode = normalizeChatAutoScrollMode(props.settings.chatAutoScroll);
  const label = `${t("chat.autoScrollMode")}: ${chatAutoScrollLabel(mode)}`;
  const active = mode !== "off";
  return html`
    <openclaw-tooltip .content=${label}>
      <button
        class="btn btn--sm btn--icon chat-settings-action ${active ? "active" : ""}"
        data-chat-auto-scroll-toggle="true"
        data-chat-auto-scroll-mode=${mode}
        aria-label=${label}
        aria-pressed=${active}
        @click=${() => {
          props.onSettingsChange({
            ...props.settings,
            chatAutoScroll: nextChatAutoScrollMode(mode),
          });
        }}
      >
        ${icons.scrollText}
        <span class="chat-settings-action__text">${t("chat.autoScrollMode")}</span>
      </button>
    </openclaw-tooltip>
  `;
}

function renderChatSendShortcutPreference(props: {
  settings: UiSettings;
  onSettingsChange: (next: UiSettings) => void;
}) {
  const shortcut = normalizeChatSendShortcut(props.settings.chatSendShortcut);
  return html`
    <label class="chat-settings-popover__preference">
      <span>${t("chat.sendShortcut")}</span>
      <select
        data-chat-send-shortcut="true"
        .value=${shortcut}
        @change=${(event: Event) => {
          props.onSettingsChange({
            ...props.settings,
            chatSendShortcut: normalizeChatSendShortcut(
              (event.currentTarget as HTMLSelectElement).value,
            ),
          });
        }}
      >
        <option value="enter">${t("chat.sendShortcutEnter")}</option>
        <option value="modifier-enter">${t("chat.sendShortcutModifierEnter")}</option>
      </select>
    </label>
  `;
}

function renderCronFilterIcon(hiddenCount: number) {
  return html`
    <span style="position: relative; display: inline-flex; align-items: center;">
      ${icons.clock}
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

function countHiddenCronSessions(
  props: Pick<ChatControlsProps, "agentsList" | "sessionKey" | "sessionsResult">,
): number {
  const sessions = props.sessionsResult;
  if (!sessions?.sessions) {
    return 0;
  }
  const activeAgentId = normalizeAgentId(
    parseAgentSessionKey(props.sessionKey)?.agentId ?? props.agentsList?.defaultId ?? "main",
  );
  const defaultAgentId = normalizeAgentId(props.agentsList?.defaultId ?? "main");

  return sessions.sessions.filter(
    (row) =>
      isCronSessionKey(row.key) &&
      row.key !== props.sessionKey &&
      isSessionKeyTiedToAgent(row.key, activeAgentId, defaultAgentId),
  ).length;
}

export function renderChatControls(props: ChatControlsProps) {
  const hideCron = props.hideCronSessions;
  const hiddenCronCount = hideCron ? countHiddenCronSessions(props) : 0;
  const disableThinkingToggle = props.onboarding;
  const showThinking = props.onboarding ? false : props.settings.chatShowThinking;
  const showToolCalls = props.onboarding ? true : props.settings.chatShowToolCalls;
  const persistCommentary = props.settings.chatPersistCommentary === true;
  const thinkingLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.thinkingToggle");
  const toolCallsLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.toolCallsToggle");
  const commentaryLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.commentaryToggle");
  const refreshDisabled =
    !props.connected ||
    props.manualRefreshInFlight ||
    props.loading ||
    props.sending ||
    props.stream !== null ||
    Boolean(props.runId);
  const cronLabel = hideCron
    ? hiddenCronCount > 0
      ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
      : t("chat.showCronSessions")
    : t("chat.hideCronSessions");
  const settingsOpen = props.settingsOpen;
  const settingsTitle = t("chat.settings");
  const settingsPopoverId = `chat-composer-settings-popover-${encodeURIComponent(props.paneId)}`;

  return html`
    <div class="chat-settings-popover-wrapper">
      <openclaw-tooltip .content=${settingsTitle}>
        <button
          class="chat-settings-chip ${settingsOpen ? "chat-settings-chip--open" : ""}"
          type="button"
          aria-label=${settingsTitle}
          aria-expanded=${settingsOpen}
          aria-controls=${settingsPopoverId}
          @click=${(event: Event) => {
            event.stopPropagation();
            (event.currentTarget as HTMLElement)
              .closest(".agent-chat__composer-controls")
              ?.querySelectorAll("details.chat-controls__inline-select[open]")
              .forEach((details) => details.removeAttribute("open"));
            props.onSettingsOpenChange(!settingsOpen, {
              trigger: event.currentTarget as HTMLElement,
            });
          }}
        >
          <span class="chat-settings-chip__icon">${icons.settings}</span>
        </button>
      </openclaw-tooltip>
      <div
        id=${settingsPopoverId}
        class="chat-settings-popover ${settingsOpen ? "chat-settings-popover--open" : ""}"
        role="dialog"
        aria-label=${settingsTitle}
      >
        <div class="chat-settings-popover__section">
          <span class="chat-settings-popover__label">${t("nav.chat")}</span>
          <div class="chat-settings-popover__toggles">
            <openclaw-tooltip .content=${t("common.refresh")}>
              <button
                class="btn btn--sm btn--icon chat-settings-action"
                ?disabled=${refreshDisabled}
                @click=${() => {
                  if (!refreshDisabled) {
                    void props.onRefresh();
                  }
                }}
                aria-label=${t("common.refresh")}
              >
                ${icons.refresh}
                <span class="chat-settings-action__text">${t("common.refresh")}</span>
              </button>
            </openclaw-tooltip>
            ${renderChatAutoScrollToggle(props)}
            <openclaw-tooltip .content=${thinkingLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${showThinking ? "active" : ""}"
                ?disabled=${disableThinkingToggle}
                @click=${() => {
                  if (disableThinkingToggle) {
                    return;
                  }
                  props.onSettingsChange({
                    ...props.settings,
                    chatShowThinking: !props.settings.chatShowThinking,
                  });
                }}
                aria-pressed=${showThinking}
                aria-label=${thinkingLabel}
              >
                ${icons.brain}
                <span class="chat-settings-action__text">${t("cron.form.thinking")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${toolCallsLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${showToolCalls ? "active" : ""}"
                ?disabled=${disableThinkingToggle}
                @click=${() => {
                  if (disableThinkingToggle) {
                    return;
                  }
                  props.onSettingsChange({
                    ...props.settings,
                    chatShowToolCalls: !props.settings.chatShowToolCalls,
                  });
                }}
                aria-pressed=${showToolCalls}
                aria-label=${toolCallsLabel}
              >
                ${icons.wrench}
                <span class="chat-settings-action__text">${t("agents.tabs.tools")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${commentaryLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${persistCommentary
                  ? "active"
                  : ""}"
                ?disabled=${disableThinkingToggle}
                @click=${() => {
                  if (disableThinkingToggle) {
                    return;
                  }
                  props.onSettingsChange({
                    ...props.settings,
                    chatPersistCommentary: !persistCommentary,
                  });
                }}
                aria-pressed=${persistCommentary}
                aria-label=${commentaryLabel}
              >
                ${persistCommentary ? icons.pin : icons.pinOff}
                <span class="chat-settings-action__text">${t("chat.commentaryLabel")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${cronLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${hideCron ? "active" : ""}"
                @click=${() => {
                  props.onToggleCronSessions?.();
                }}
                aria-pressed=${hideCron}
                aria-label=${cronLabel}
              >
                ${renderCronFilterIcon(hiddenCronCount)}
                <span class="chat-settings-action__text">${t("cron.actions.history")}</span>
              </button>
            </openclaw-tooltip>
          </div>
          ${renderChatSendShortcutPreference(props)}
        </div>
        ${props.realtimeTalkOptions && props.onRealtimeTalkOptionsChange
          ? html`
              <div class="chat-settings-popover__section">
                <span class="chat-settings-popover__label">${t("chat.voiceSettings")}</span>
                ${renderRealtimeTalkOptions({
                  realtimeTalkOptions: props.realtimeTalkOptions,
                  realtimeTalkInputDevices: props.realtimeTalkInputDevices,
                  realtimeTalkInputDeviceId: props.realtimeTalkInputDeviceId,
                  realtimeTalkInputLoading: props.realtimeTalkInputLoading,
                  realtimeTalkInputError: props.realtimeTalkInputError,
                  onRealtimeTalkOptionsChange: props.onRealtimeTalkOptionsChange,
                  onRealtimeTalkInputRefresh: props.onRealtimeTalkInputRefresh,
                  onRealtimeTalkInputSelect: props.onRealtimeTalkInputSelect,
                  canOpenRealtimeTalkSettings: props.canOpenRealtimeTalkSettings,
                  onOpenRealtimeTalkSettings: props.onOpenRealtimeTalkSettings,
                  embedded: true,
                })}
              </div>
            `
          : ""}
      </div>
    </div>
    <div
      class="chat-composer-model-control"
      @click=${() => {
        if (props.settingsOpen) {
          props.onSettingsOpenChange(false);
        }
      }}
    >
      ${renderChatModelControls(props.model)}
    </div>
  `;
}
