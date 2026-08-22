import { html, nothing } from "lit";
import { icons } from "../components/icons.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { t } from "../i18n/index.ts";
import {
  renderScopeUpgradeShellStatusTrigger,
  SCOPE_UPGRADE_DESKTOP_TRIGGER_ID,
  SCOPE_UPGRADE_MOBILE_TRIGGER_ID,
} from "./scope-upgrade-shell.ts";

const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";

export function renderShellChromeControls(options: {
  onboarding: boolean;
  settingsTakeover: boolean;
  mobileNavLayout: boolean;
  nativeWebChrome: boolean;
  navCollapsed: boolean;
  newSessionAccess: { allowed: boolean; reason?: string };
  selectedAgentId: string;
  custodianPanelAvailable: boolean;
  showScopeUpgradeStatus: boolean;
  onToggleNavigation: () => void;
  onOpenNewSession: (agentId: string) => void;
  onOpenPalette: () => void;
  onOpenScopeUpgrade: () => void;
}) {
  const regularControls =
    !options.onboarding && !options.settingsTakeover && !options.mobileNavLayout;
  const accessOnly =
    options.showScopeUpgradeStatus &&
    !options.mobileNavLayout &&
    !options.nativeWebChrome &&
    (options.onboarding || options.settingsTakeover);
  return html`
    ${regularControls
      ? html`<div
          class="shell-chrome-controls ${options.showScopeUpgradeStatus
            ? "shell-chrome-controls--has-access"
            : ""}"
        >
          <openclaw-tooltip
            .content=${`${t(options.navCollapsed ? "nav.expand" : "nav.collapse")} (⌘B)`}
          >
            <button
              type="button"
              class="shell-chrome-controls__button shell-chrome-controls__nav-toggle"
              aria-label=${t(options.navCollapsed ? "nav.expand" : "nav.collapse")}
              aria-expanded=${options.navCollapsed ? "false" : "true"}
              @click=${options.onToggleNavigation}
            >
              ${options.navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}
            </button>
          </openclaw-tooltip>
          ${options.navCollapsed
            ? html`<openclaw-tooltip
                .content=${options.newSessionAccess.allowed
                  ? t("chat.runControls.newSession")
                  : options.newSessionAccess.reason}
              >
                <button
                  type="button"
                  class="shell-chrome-controls__button shell-chrome-controls__new-thread"
                  aria-label=${t("chat.runControls.newSession")}
                  ?disabled=${!options.newSessionAccess.allowed}
                  @click=${() => options.onOpenNewSession(options.selectedAgentId)}
                >
                  ${icons.plus}
                </button>
              </openclaw-tooltip>`
            : nothing}
          <openclaw-tooltip .content=${`${t("chat.openCommandPalette")} (${PALETTE_SHORTCUT})`}>
            <button
              type="button"
              class="shell-chrome-controls__button shell-chrome-controls__search"
              aria-label=${t("chat.openCommandPalette")}
              @click=${options.onOpenPalette}
            >
              ${icons.search}
            </button>
          </openclaw-tooltip>
          ${options.showScopeUpgradeStatus
            ? renderScopeUpgradeShellStatusTrigger({
                id: SCOPE_UPGRADE_DESKTOP_TRIGGER_ID,
                className: "shell-chrome-controls__button shell-chrome-controls__scope-upgrade",
              })
            : nothing}
          ${options.navCollapsed && options.custodianPanelAvailable
            ? html`<openclaw-tooltip .content=${t("nav.askOpenClaw")}>
                <button
                  type="button"
                  class="shell-chrome-controls__button shell-chrome-controls__custodian"
                  aria-label=${t("nav.askOpenClaw")}
                  @click=${() =>
                    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT))}
                >
                  ${icons.lobster}
                </button>
              </openclaw-tooltip>`
            : nothing}
        </div>`
      : nothing}
    ${accessOnly
      ? html`<div class="shell-chrome-controls shell-chrome-controls--access-only">
          ${renderScopeUpgradeShellStatusTrigger({
            id: SCOPE_UPGRADE_DESKTOP_TRIGGER_ID,
            className: "shell-chrome-controls__button shell-chrome-controls__scope-upgrade",
          })}
        </div>`
      : nothing}
    ${options.onboarding && options.mobileNavLayout && options.showScopeUpgradeStatus
      ? html`<div class="shell-onboarding-access">
          ${renderScopeUpgradeShellStatusTrigger({
            id: SCOPE_UPGRADE_MOBILE_TRIGGER_ID,
            className: "topbar-icon-btn",
            onActivate: options.onOpenScopeUpgrade,
          })}
        </div>`
      : nothing}
  `;
}
