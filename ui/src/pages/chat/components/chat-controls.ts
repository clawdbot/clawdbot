// Chat-owned composer display controls: the View menu plus model controls.
import { html } from "lit";
import type { UiSettings } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { renderChatModelControls, type ChatModelControlsProps } from "./chat-model-controls.ts";

type ChatControlsProps = {
  paneId: string;
  model: ChatModelControlsProps;
  onboarding: boolean;
  settings: UiSettings;
  viewMenuOpen: boolean;
  onSettingsChange: (next: UiSettings) => void;
  onViewMenuOpenChange: (
    open: boolean,
    options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
  ) => void;
};

type ChatViewMenuRow = {
  label: string;
  checked: boolean;
  onToggle: () => void;
};

function chatViewMenuRows(props: ChatControlsProps): ChatViewMenuRow[] {
  const { settings, onboarding } = props;
  // Onboarding pins the display: no thinking noise, tool calls visible.
  const showThinking = onboarding ? false : settings.chatShowThinking;
  const showToolCalls = onboarding ? true : settings.chatShowToolCalls;
  const persistCommentary = settings.chatPersistCommentary === true;
  return [
    {
      label: t("chat.view.reasoning"),
      checked: showThinking,
      onToggle: () =>
        props.onSettingsChange({ ...settings, chatShowThinking: !settings.chatShowThinking }),
    },
    {
      label: t("chat.view.toolCalls"),
      checked: showToolCalls,
      onToggle: () =>
        props.onSettingsChange({ ...settings, chatShowToolCalls: !settings.chatShowToolCalls }),
    },
    {
      label: t("chat.view.commentary"),
      checked: persistCommentary,
      onToggle: () =>
        props.onSettingsChange({ ...settings, chatPersistCommentary: !persistCommentary }),
    },
  ];
}

export function renderChatControls(props: ChatControlsProps) {
  const open = props.viewMenuOpen;
  const menuTitle = props.onboarding ? t("chat.onboardingDisabled") : t("chat.view.menu");
  const menuId = `chat-view-menu-${encodeURIComponent(props.paneId)}`;
  return html`
    <div class="chat-view-menu-wrapper">
      <openclaw-tooltip .content=${menuTitle}>
        <button
          class="chat-view-menu-trigger ${open ? "chat-view-menu-trigger--open" : ""}"
          type="button"
          aria-label=${menuTitle}
          aria-haspopup="menu"
          aria-expanded=${open}
          aria-controls=${menuId}
          @click=${(event: Event) => {
            event.stopPropagation();
            props.onViewMenuOpenChange(!open, { trigger: event.currentTarget as HTMLElement });
          }}
        >
          ${icons.eye}
        </button>
      </openclaw-tooltip>
      <div
        id=${menuId}
        class="chat-view-menu ${open ? "chat-view-menu--open" : ""}"
        role="menu"
        aria-label=${t("chat.view.menu")}
      >
        ${chatViewMenuRows(props).map(
          (row) => html`
            <button
              type="button"
              class="chat-view-menu__item"
              role="menuitemcheckbox"
              aria-checked=${row.checked}
              ?disabled=${props.onboarding}
              @click=${() => {
                if (!props.onboarding) {
                  row.onToggle();
                }
              }}
            >
              <span class="chat-view-menu__check" aria-hidden="true">
                ${row.checked ? icons.check : ""}
              </span>
              <span class="chat-view-menu__text">${row.label}</span>
            </button>
          `,
        )}
      </div>
    </div>
    <div
      class="chat-composer-model-control"
      @click=${() => {
        if (open) {
          props.onViewMenuOpenChange(false);
        }
      }}
    >
      ${renderChatModelControls(props.model)}
    </div>
  `;
}
