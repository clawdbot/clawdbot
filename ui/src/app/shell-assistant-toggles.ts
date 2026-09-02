import { html, nothing } from "lit";
import { icons } from "../components/icons.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  HOME_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { t } from "../i18n/index.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";

/** Collapsed-sidebar chrome buttons for the assistant dock destinations. */
export function renderCollapsedAssistantToggles(options: {
  homeAvailable: boolean;
  custodianAvailable: boolean;
}) {
  const toggles = [
    {
      available: options.homeAvailable,
      kind: "home",
      label: t("assistantPanel.toggle"),
      tooltip: `${t("assistantPanel.toggle")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.homePanel)})`,
      event: HOME_PANEL_TOGGLE_EVENT,
      icon: icons.home,
    },
    {
      available: options.custodianAvailable,
      kind: "custodian",
      label: t("nav.askOpenClaw"),
      tooltip: t("nav.askOpenClaw"),
      event: CUSTODIAN_PANEL_TOGGLE_EVENT,
      icon: icons.lobster,
    },
  ] as const;
  return toggles.map((toggle) =>
    toggle.available
      ? html`<openclaw-tooltip .content=${toggle.tooltip}>
          <button
            type="button"
            class="shell-chrome-controls__button shell-chrome-controls__${toggle.kind}"
            aria-label=${toggle.label}
            @click=${() => window.dispatchEvent(new CustomEvent(toggle.event))}
          >
            ${toggle.icon}
          </button>
        </openclaw-tooltip>`
      : nothing,
  );
}
