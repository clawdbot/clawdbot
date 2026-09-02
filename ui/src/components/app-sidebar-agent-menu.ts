// Sidebar identity menus, split out of app-sidebar.ts to keep that hot
// component inside the TS LOC ratchet.
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { AgentIdentityResult } from "../api/types.ts";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import { pathForAgentPanel } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-catalog.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import type { PresenceViewer } from "../lib/presence-users.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  DEBUG_OVERLAY_SHORTCUT_LABEL,
  requestDebugOverlayToggle,
} from "../pages/debug/debug-overlay-contract.ts";
import { renderAgentSelectAvatar, renderAgentSelectCopy } from "./agent-select.ts";
import { icons, type IconName } from "./icons.ts";
import "./sidebar-build-chip.ts";
import "./viewer-facepile.ts";
import {
  consumeDropdownKeyboardDismissal,
  syncDropdownItemRadio,
  trackDropdownKeyboardDismissal,
} from "./web-awesome.ts";

// External rows of the footer identity menu. Docs-first: public docs pages over
// raw GitHub, matching the ClawSweeper docs-link policy for user-facing copy.
const IDENTITY_MENU_LINKS: ReadonlyArray<{
  href: string;
  icon: IconName;
  label: () => string;
}> = [
  { href: "https://docs.openclaw.ai", icon: "book", label: () => t("common.docs") },
  {
    href: "https://docs.openclaw.ai/help",
    icon: "messageSquare",
    label: () => t("agentChip.getHelp"),
  },
  { href: "https://discord.gg/clawd", icon: "users", label: () => t("agentChip.discord") },
  {
    href: "https://docs.openclaw.ai/releases",
    icon: "scrollText",
    label: () => t("agentChip.viewChangelog"),
  },
];

const AGENT_VALUE_PREFIX = "agent:";
const COMMAND_VALUE_PREFIX = "command:";
const LINK_VALUE_PREFIX = "link:";
const sidebarMenuTypeahead = new WeakMap<
  HTMLElement,
  { query: string; timeout: ReturnType<typeof setTimeout> }
>();

function sidebarMenuItems(dropdown: Element | null) {
  return [
    ...(dropdown?.querySelectorAll<HTMLElement & { active: boolean }>(
      ":scope > wa-dropdown-item:not([disabled]), :scope > .sidebar-agent-menu__agent-grid > wa-dropdown-item:not([disabled])",
    ) ?? []),
  ];
}

function focusSidebarMenuItem(
  items: Array<HTMLElement & { active: boolean }>,
  target: HTMLElement,
) {
  items.forEach((item) => (item.active = item === target));
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "nearest" });
}

// Nested overlays bubble lifecycle events through the dropdown. Only the
// owner's completed hide may remove its menu or consume its Escape state.
function closeMenuAfterOwnDropdownHide(event: Event, onClose: (restoreFocus?: boolean) => void) {
  if (event.target !== event.currentTarget) {
    return;
  }
  onClose(consumeDropdownKeyboardDismissal(event));
}

function moveSidebarMenuFocus(event: KeyboardEvent): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return false;
  }
  if (event.target instanceof HTMLInputElement && (event.key === "Home" || event.key === "End")) {
    return false;
  }
  const dropdown = (event.currentTarget as HTMLElement).closest("wa-dropdown");
  const items = sidebarMenuItems(dropdown);
  const footer = dropdown?.querySelector<HTMLElement>(".sidebar-identity-menu__footer");
  const controls = [
    ...items,
    ...(footer?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []),
  ];
  const current = event.target instanceof HTMLElement ? event.target : null;
  const index = current ? controls.indexOf(current) : -1;
  if (footer && index < 0) {
    return false;
  }
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const target =
    event.key === "Home"
      ? items[0]
      : event.key === "End"
        ? items.at(-1)
        : index < 0
          ? items.at(direction === 1 ? 0 : -1)
          : controls[(index + direction + controls.length) % controls.length];
  if (!target || (footer && !footer.contains(current) && !footer.contains(target))) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  // Native footer actions are outside Web Awesome's roving item list; reset
  // its active row on both crossings so reverse navigation cannot skip one.
  focusSidebarMenuItem(items, target);
  return true;
}

function typeaheadSidebarMenuFocus(event: KeyboardEvent): boolean {
  if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  const dropdown = event.currentTarget;
  if (!(dropdown instanceof HTMLElement)) {
    return false;
  }
  const previous = sidebarMenuTypeahead.get(dropdown);
  if (event.key === " " && !previous?.query) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  if (previous) {
    clearTimeout(previous.timeout);
  }
  const query = `${previous?.query ?? ""}${event.key}`.trim().toLowerCase();
  const timeout = setTimeout(() => sidebarMenuTypeahead.delete(dropdown), 1_000);
  sidebarMenuTypeahead.set(dropdown, { query, timeout });
  const items = sidebarMenuItems(dropdown);
  const target = items.find((item) =>
    (item.textContent ?? "").trim().toLowerCase().startsWith(query),
  );
  if (target) {
    focusSidebarMenuItem(items, target);
  }
  return true;
}

function focusActiveAgentMenuItem(dropdown: HTMLElement) {
  const items = sidebarMenuItems(dropdown);
  const target =
    items.find((item) => item.classList.contains("sidebar-agent-menu__agent-switch--active")) ??
    items.find((item) => item.classList.contains("sidebar-agent-menu__agent-switch"));
  if (!target) {
    return;
  }
  focusSidebarMenuItem(items, target);
}

type AgentMenuAgent = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string; avatar?: string; avatarUrl?: string };
};

type SidebarAgentMenuParams = {
  position: { x: number; top: number };
  basePath: string;
  activeId: string;
  activeName: string;
  agents: readonly AgentMenuAgent[];
  identities: ReadonlyMap<string, AgentIdentityResult>;
  pinnedAgentIds: readonly string[];
  connected: boolean;
  openMode: "hover" | "click";
  agentUnreadCount: (agentId: string) => number;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onAfterShow: () => void;
  onSwitchAgent: (agentId: string) => void;
  onAskCapabilities: (agentId: string) => void;
  onTabAway: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
};

type SidebarIdentityMenuParams = {
  position: { x: number; bottom: number; width: number };
  canPairDevice: boolean;
  basePath: string;
  gatewayVersion: string | null;
  updateAttentionDismissed: boolean;
  profileViewer?: PresenceViewer;
  offline: boolean;
  themeMode: ThemeMode;
  triggerWidth: number;
  onTabAway: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  onPairMobile: () => void;
  onRetryConnect?: () => void;
};

function sidebarAgentMenuRows(params: {
  agents: readonly AgentMenuAgent[];
  pinnedAgentIds: readonly string[];
}) {
  const { agents } = params;
  const availableIds = new Set(agents.map((agent) => normalizeAgentId(agent.id)));
  const pinnedIds = new Set(
    params.pinnedAgentIds
      .map((agentId) => normalizeAgentId(agentId))
      .filter((agentId) => availableIds.has(agentId)),
  );
  return agents.toSorted((a, b) => {
    const aPinned = pinnedIds.has(normalizeAgentId(a.id)) ? 0 : 1;
    const bPinned = pinnedIds.has(normalizeAgentId(b.id)) ? 0 : 1;
    return aPinned - bPinned;
  });
}

function renderAgentRow(agent: AgentMenuAgent, params: SidebarAgentMenuParams) {
  const agentId = normalizeAgentId(agent.id);
  const identity = params.identities.get(agentId) ?? null;
  const label = normalizeAgentLabel(agent, identity);
  const active = agentId === params.activeId;
  const unread = active ? 0 : params.agentUnreadCount(agentId);
  const option = { value: agentId, label, agent };
  return html`
    <wa-dropdown-item
      class="sidebar-customize-menu__item sidebar-agent-menu__agent-switch agent-select__option ${active
        ? "sidebar-agent-menu__agent-switch--active"
        : ""}"
      value=${`${AGENT_VALUE_PREFIX}${encodeURIComponent(agentId)}`}
      type="checkbox"
      role="menuitemradio"
      aria-checked=${String(active)}
      ${ref((element) => syncDropdownItemRadio(element, active))}
    >
      <span class="sidebar-agent-menu__agent-tile">
        <span class="sidebar-agent-menu__agent-avatar">
          ${renderAgentSelectAvatar(option, identity)}
        </span>
        ${renderAgentSelectCopy(option)}
        <span class="sidebar-agent-menu__agent-status">
          ${unread > 0
            ? html`<span
                class="session-unread-dot"
                role="img"
                aria-label=${t("sessionsView.unread")}
              ></span>`
            : nothing}
        </span>
      </span>
    </wa-dropdown-item>
  `;
}

function renderIdentityMenuHelpSubmenu() {
  return html`
    ${IDENTITY_MENU_LINKS.map(
      (link) => html`
        <wa-dropdown-item
          slot="submenu"
          class="sidebar-customize-menu__item"
          value=${`${LINK_VALUE_PREFIX}${encodeURIComponent(link.href)}`}
          data-new-tab-action
          @click=${(event: MouseEvent) => {
            if (event.target instanceof Element && event.target.closest("a")) {
              (event.currentTarget as HTMLElement).dataset.nativeNavigation = "true";
            }
          }}
        >
          <a
            href=${link.href}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            tabindex="-1"
          >
            <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons[link.icon]}</span>
            <span class="sidebar-customize-menu__text">${link.label()}</span>
          </a>
        </wa-dropdown-item>
      `,
    )}
  `;
}

export function renderSidebarAgentMenu(params: SidebarAgentMenuParams) {
  const position = params.position;
  const { activeId, activeName, agents } = params;
  const rows = sidebarAgentMenuRows(params);
  return html`
    <wa-dropdown
      class="sidebar-customize-menu sidebar-agent-menu"
      data-chat-autotype-exempt
      .open=${true}
      placement="bottom-start"
      .distance=${0}
      aria-label=${t("agentChip.menuLabel")}
      @pointerenter=${params.onPointerEnter}
      @pointerleave=${params.onPointerLeave}
      @wa-select=${(event: CustomEvent<{ item: HTMLElement & { value?: string } }>) => {
        event.preventDefault();
        const item = event.detail.item;
        if (item.dataset.nativeNavigation) {
          delete item.dataset.nativeNavigation;
          params.onClose(false);
          return;
        }
        const value = item.value;
        if (!value) {
          return;
        }
        params.onClose(false);
        if (value.startsWith(AGENT_VALUE_PREFIX)) {
          params.onSwitchAgent(decodeURIComponent(value.slice(AGENT_VALUE_PREFIX.length)));
          return;
        }
        switch (value) {
          case `${COMMAND_VALUE_PREFIX}capabilities`:
            params.onAskCapabilities(activeId);
            break;
          case `${COMMAND_VALUE_PREFIX}agent-settings`:
            params.onNavigate("agents", {
              pathname: pathForAgentPanel(activeId, null, params.basePath),
            });
            break;
          case `${COMMAND_VALUE_PREFIX}new-agent`:
            params.onNavigate("custodian", { search: "?intent=new-agent" });
            break;
        }
      }}
      @wa-after-show=${(event: Event) => {
        if (!(event.currentTarget instanceof HTMLElement)) {
          return;
        }
        params.onAfterShow();
        if (params.openMode === "hover") {
          return;
        }
        focusActiveAgentMenuItem(event.currentTarget);
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (moveSidebarMenuFocus(event)) {
          return;
        }
        if (typeaheadSidebarMenuFocus(event)) {
          return;
        }
        const item =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>(
                ".sidebar-agent-menu__agent-grid > wa-dropdown-item:not([disabled])",
              )
            : null;
        if ((event.key === "Enter" || event.key === " ") && item) {
          event.preventDefault();
          event.stopPropagation();
          item.click();
          return;
        }
        trackDropdownKeyboardDismissal(event, params.onTabAway);
      }}
      @wa-after-hide=${(event: Event) => closeMenuAfterOwnDropdownHide(event, params.onClose)}
    >
      <button
        slot="trigger"
        type="button"
        tabindex="-1"
        aria-hidden="true"
        aria-label=${t("agentChip.menuLabel")}
        style="position: fixed; left: ${position.x}px; top: ${position.top}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
      ></button>
      ${agents.length > 1
        ? html`
            <div class="sidebar-customize-menu__title">${t("agentChip.agents")}</div>
            <div class="sidebar-agent-menu__agent-grid">
              ${rows.map((entry) => renderAgentRow(entry, params))}
            </div>
          `
        : nothing}
      <div class="sidebar-customize-menu__separator" role="separator"></div>
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:new-agent">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.users}</span>
        <span class="sidebar-customize-menu__text">${t("custodian.newAgent")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item
        class="sidebar-customize-menu__item"
        value="command:capabilities"
        ?disabled=${!params.connected}
      >
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.bot}</span>
        <span class="sidebar-customize-menu__text">
          ${t("agentChip.whatCanAgentDo", { name: activeName })}
        </span>
      </wa-dropdown-item>
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:agent-settings">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.users}</span>
        <span class="sidebar-customize-menu__text">${t("agentChip.agentSettings")}</span>
      </wa-dropdown-item>
    </wa-dropdown>
  `;
}

export function renderSidebarIdentityMenu(params: SidebarIdentityMenuParams) {
  const position = params.position;
  const profileName = params.profileViewer?.name ?? params.profileViewer?.email;
  const profileEmail =
    params.profileViewer?.email && params.profileViewer.email !== profileName
      ? params.profileViewer.email
      : null;
  return html`
    <wa-dropdown
      class="sidebar-customize-menu sidebar-identity-menu"
      style=${`--sidebar-identity-menu-min-width: ${params.triggerWidth}px`}
      .open=${true}
      placement="top-start"
      .distance=${0}
      aria-label=${t("profilePage.identity.menuLabel")}
      @wa-select=${(event: CustomEvent<{ item: HTMLElement & { value?: string } }>) => {
        event.preventDefault();
        const item = event.detail.item;
        if (item.dataset.nativeNavigation) {
          delete item.dataset.nativeNavigation;
          params.onClose(false);
          return;
        }
        const value = item.value;
        if (!value) {
          return;
        }
        params.onClose(false);
        if (value.startsWith(LINK_VALUE_PREFIX)) {
          openExternalUrlSafe(decodeURIComponent(value.slice(LINK_VALUE_PREFIX.length)));
          return;
        }
        switch (value) {
          case `${COMMAND_VALUE_PREFIX}profile`:
            params.onNavigate("profile", { hash: "#settings-profile-identity" });
            break;
          case `${COMMAND_VALUE_PREFIX}settings`:
            params.onNavigate("appearance");
            break;
          case `${COMMAND_VALUE_PREFIX}usage`:
            params.onNavigate("usage");
            break;
          case `${COMMAND_VALUE_PREFIX}pair-mobile`:
            params.onPairMobile();
            break;
          case `${COMMAND_VALUE_PREFIX}apps`:
            params.onNavigate("apps");
            break;
          case `${COMMAND_VALUE_PREFIX}debug-overlay`:
            requestDebugOverlayToggle();
            break;
          case `${COMMAND_VALUE_PREFIX}retry-connect`:
            params.onRetryConnect?.();
            break;
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (!moveSidebarMenuFocus(event)) {
          trackDropdownKeyboardDismissal(event, params.onTabAway);
        }
      }}
      @wa-after-hide=${(event: Event) => closeMenuAfterOwnDropdownHide(event, params.onClose)}
    >
      <button
        slot="trigger"
        type="button"
        tabindex="-1"
        aria-hidden="true"
        aria-label=${t("profilePage.identity.menuLabel")}
        style="position: fixed; left: ${position.x}px; bottom: ${position.bottom}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
      ></button>
      ${profileName
        ? html`<wa-dropdown-item
              class="sidebar-customize-menu__item sidebar-identity-menu__header"
              value="command:profile"
            >
              <span slot="icon" class="sidebar-identity-menu__avatar" aria-hidden="true">
                <openclaw-viewer-avatar
                  .user=${params.profileViewer}
                  variant="footer"
                ></openclaw-viewer-avatar>
              </span>
              <span class="sidebar-identity-menu__identity">
                <span class="sidebar-identity-menu__name" title=${profileName}>${profileName}</span>
                ${profileEmail
                  ? html`<span class="sidebar-identity-menu__email" title=${profileEmail}
                      >${profileEmail}</span
                    >`
                  : nothing}
              </span>
            </wa-dropdown-item>
            <div class="sidebar-customize-menu__separator" role="separator"></div>`
        : nothing}
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:settings">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.settings}</span>
        <span class="sidebar-customize-menu__text">${t("nav.settings")}</span>
        <kbd slot="details" class="session-menu__shortcut" aria-hidden="true"
          >${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.appearanceSettings)}</kbd
        >
      </wa-dropdown-item>
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:usage">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.coins}</span>
        <span class="sidebar-customize-menu__text">${titleForRoute("usage")}</span>
      </wa-dropdown-item>
      <div class="sidebar-customize-menu__separator" role="separator"></div>
      <wa-dropdown-item
        class="sidebar-customize-menu__item sidebar-pair-mobile"
        value="command:pair-mobile"
        ?disabled=${!params.canPairDevice}
        title=${params.canPairDevice ? nothing : t("devices.pairing.adminRequired")}
      >
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.smartphone}</span>
        <span class="sidebar-customize-menu__text">${t("devices.pairing.button")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:apps">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.layoutGrid}</span>
        <span class="sidebar-customize-menu__text">${t("agentChip.getApps")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:debug-overlay">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.activity}</span>
        <span class="sidebar-customize-menu__text">${t("debug.overlay.title")}</span>
        <span slot="details" class="session-menu__shortcut" aria-hidden="true"
          >${DEBUG_OVERLAY_SHORTCUT_LABEL}</span
        >
      </wa-dropdown-item>
      <div class="sidebar-customize-menu__separator" role="separator"></div>
      <wa-dropdown-item
        class="sidebar-customize-menu__item sidebar-identity-menu__help"
        value="command:help"
      >
        <span slot="icon" class="nav-item__icon" aria-hidden="true"
          >${icons.circleQuestionMark}</span
        >
        <span class="sidebar-customize-menu__text">${t("agentChip.help")}</span>
        ${renderIdentityMenuHelpSubmenu()}
      </wa-dropdown-item>
      ${params.offline
        ? html`<div class="sidebar-customize-menu__separator" role="separator"></div>
            <wa-dropdown-item
              class="sidebar-customize-menu__item sidebar-identity-menu__retry"
              value="command:retry-connect"
            >
              <span class="sidebar-customize-menu__text">${t("connection.retryNow")}</span>
            </wa-dropdown-item>`
        : nothing}
      <div class="sidebar-customize-menu__separator" role="separator"></div>
      <div class="sidebar-identity-menu__footer">
        <openclaw-sidebar-build-chip
          .variant=${"identity"}
          .basePath=${params.basePath}
          .gatewayVersion=${params.gatewayVersion}
          .updateAttentionDismissed=${params.updateAttentionDismissed}
          .onNavigate=${(routeId: "about") => {
            params.onClose();
            params.onNavigate(routeId);
          }}
        ></openclaw-sidebar-build-chip>
        <span class="sidebar-mode-switch">
          <openclaw-theme-mode-toggle .mode=${params.themeMode}></openclaw-theme-mode-toggle>
        </span>
      </div>
    </wa-dropdown>
  `;
}
