// Sidebar agent-chip menu (switcher, filter, utility rows), split out of
// app-sidebar.ts to keep that hot component inside the TS LOC ratchet.
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { renderAgentSelectAvatar, renderAgentSelectCopy } from "./agent-select.ts";
import { icons, type IconName } from "./icons.ts";
import {
  consumeDropdownKeyboardDismissal,
  syncDropdownItemRadio,
  trackDropdownKeyboardDismissal,
} from "./web-awesome.ts";

// External rows of the footer agent menu. Docs-first: public docs pages over
// raw GitHub, matching the ClawSweeper docs-link policy for user-facing copy.
const AGENT_MENU_LINKS: ReadonlyArray<{ href: string; icon: IconName; label: () => string }> = [
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

/** Above this roster size the chip menu switches to pinned agents + filter. */
const QUICK_SWITCH_AGENT_LIMIT = 10;
const AGENT_VALUE_PREFIX = "agent:";
const COMMAND_VALUE_PREFIX = "command:";
const LINK_VALUE_PREFIX = "link:";

type AgentMenuAgent = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string; avatar?: string; avatarUrl?: string };
};

type SidebarAgentMenuParams = {
  position: { x: number; bottom: number } | null;
  activeId: string;
  activeName: string;
  agents: readonly AgentMenuAgent[];
  filter: string;
  pinnedAgentIds: readonly string[];
  connected: boolean;
  canPairDevice: boolean;
  basePath: string;
  gatewayVersion: string | null;
  themeMode: ThemeMode;
  agentUnreadCount: (agentId: string) => number;
  agentApprovalCount: (agentId: string) => number;
  onFilterChange: (next: string) => void;
  onSwitchAgent: (agentId: string) => void;
  onAskCapabilities: (agentId: string) => void;
  onTabAway: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  onPairMobile: () => void;
};

/** Rows for the chip switcher. Small rosters list everything; past
    QUICK_SWITCH_AGENT_LIMIT the menu shows pinned agents (plus the active
    one) and the filter searches the full roster. */
function sidebarAgentMenuRows(params: {
  agents: readonly AgentMenuAgent[];
  activeId: string;
  filter: string;
  pinnedAgentIds: readonly string[];
}) {
  const { agents, activeId } = params;
  const availableIds = new Set(agents.map((agent) => normalizeAgentId(agent.id)));
  const pinnedIds = new Set(
    params.pinnedAgentIds
      .map((agentId) => normalizeAgentId(agentId))
      .filter((agentId) => availableIds.has(agentId)),
  );
  const sorted = agents.toSorted((a, b) => {
    const aPinned = pinnedIds.has(normalizeAgentId(a.id)) ? 0 : 1;
    const bPinned = pinnedIds.has(normalizeAgentId(b.id)) ? 0 : 1;
    return aPinned - bPinned;
  });
  if (agents.length <= QUICK_SWITCH_AGENT_LIMIT) {
    return { rows: sorted, showFilter: false };
  }
  const query = params.filter.trim().toLowerCase();
  if (query) {
    const rows = sorted.filter((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return (
        agentId.toLowerCase().includes(query) ||
        normalizeAgentLabel(entry).toLowerCase().includes(query)
      );
    });
    return { rows, showFilter: true };
  }
  if (pinnedIds.size > 0) {
    return {
      rows: sorted.filter((entry) => {
        const agentId = normalizeAgentId(entry.id);
        return pinnedIds.has(agentId) || agentId === activeId;
      }),
      showFilter: true,
    };
  }
  let rows = sorted.slice(0, QUICK_SWITCH_AGENT_LIMIT);
  if (!rows.some((entry) => normalizeAgentId(entry.id) === activeId)) {
    const activeAgent = sorted.find((entry) => normalizeAgentId(entry.id) === activeId);
    if (activeAgent) {
      rows = [...rows.slice(0, QUICK_SWITCH_AGENT_LIMIT - 1), activeAgent];
    }
  }
  return { rows, showFilter: true };
}

function renderAgentRow(agent: AgentMenuAgent, params: SidebarAgentMenuParams) {
  const agentId = normalizeAgentId(agent.id);
  const label = normalizeAgentLabel(agent);
  const active = agentId === params.activeId;
  const unread = active ? 0 : params.agentUnreadCount(agentId);
  const approvals = params.agentApprovalCount(agentId);
  const approvalLabel = t(
    approvals === 1 ? "execApproval.agentPendingOne" : "execApproval.agentPending",
    { count: String(approvals) },
  );
  const option = { value: agentId, label, agent };
  return html`
    <wa-dropdown-item
      class="sidebar-customize-menu__item sidebar-agent-menu__agent-switch agent-select__option"
      value=${`${AGENT_VALUE_PREFIX}${encodeURIComponent(agentId)}`}
      type="checkbox"
      role="menuitemradio"
      aria-checked=${String(active)}
      ${ref((element) => syncDropdownItemRadio(element, active))}
    >
      <span slot="icon">${renderAgentSelectAvatar(option)}</span>
      ${renderAgentSelectCopy(option)}
      ${approvals > 0
        ? html`<span
            slot="details"
            class="sidebar-agent-approval-count"
            aria-label=${approvalLabel}
            title=${approvalLabel}
            >${approvals}</span
          >`
        : nothing}
      ${active
        ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
            >${icons.check}</span
          >`
        : nothing}
      ${unread > 0
        ? html`<span
            slot="details"
            class="session-unread-dot"
            role="img"
            aria-label=${t("sessionsView.unread")}
          ></span>`
        : nothing}
    </wa-dropdown-item>
  `;
}

function renderAgentMenuHelpSubmenu() {
  return html`
    ${AGENT_MENU_LINKS.map(
      (link) => html`
        <wa-dropdown-item
          slot="submenu"
          class="sidebar-customize-menu__item"
          value=${`${LINK_VALUE_PREFIX}${encodeURIComponent(link.href)}`}
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
  if (!position) {
    return nothing;
  }
  const { activeId, activeName, agents } = params;
  const { rows, showFilter } = sidebarAgentMenuRows(params);
  return html`
    <openclaw-menu-surface>
      <wa-dropdown
        class="sidebar-customize-menu sidebar-agent-menu"
        .open=${true}
        placement="top-start"
        .distance=${0}
        aria-label=${t("agentChip.menuLabel")}
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
          if (value.startsWith(LINK_VALUE_PREFIX)) {
            openExternalUrlSafe(decodeURIComponent(value.slice(LINK_VALUE_PREFIX.length)));
            return;
          }
          switch (value) {
            case `${COMMAND_VALUE_PREFIX}capabilities`:
              params.onAskCapabilities(activeId);
              break;
            case `${COMMAND_VALUE_PREFIX}agent-settings`:
              params.onNavigate("agents", { search: `?agent=${encodeURIComponent(activeId)}` });
              break;
            case `${COMMAND_VALUE_PREFIX}new-agent`:
              params.onNavigate("custodian", { search: "?intent=new-agent" });
              break;
            case `${COMMAND_VALUE_PREFIX}settings`:
              params.onNavigate("config");
              break;
            case `${COMMAND_VALUE_PREFIX}pair-mobile`:
              params.onPairMobile();
              break;
            case `${COMMAND_VALUE_PREFIX}apps`:
              params.onNavigate("apps");
              break;
          }
        }}
        @wa-after-show=${(event: Event) => {
          if (showFilter) {
            (event.currentTarget as HTMLElement)
              .querySelector<HTMLInputElement>(".sidebar-agent-menu__filter input")
              ?.focus();
          }
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, params.onTabAway)}
        @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${t("agentChip.menuLabel")}
          style="position: fixed; left: ${position.x}px; bottom: ${position.bottom}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        ${agents.length > 1
          ? html`
              <div class="sidebar-customize-menu__title">${t("agentChip.agents")}</div>
              ${showFilter
                ? html`
                    <div class="sidebar-agent-menu__filter">
                      <input
                        type="text"
                        .value=${params.filter}
                        placeholder=${t("agentChip.filterAgents")}
                        aria-label=${t("agentChip.filterAgents")}
                        @input=${(event: Event) =>
                          params.onFilterChange((event.target as HTMLInputElement).value)}
                        @keydown=${(event: KeyboardEvent) => {
                          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                            event.preventDefault();
                            event.stopPropagation();
                            const dropdown = (event.currentTarget as HTMLElement).closest(
                              "wa-dropdown",
                            );
                            const items = Array.from(dropdown?.children ?? []).filter(
                              (child): child is HTMLElement & { active: boolean } =>
                                child instanceof HTMLElement &&
                                child.localName === "wa-dropdown-item" &&
                                !child.hasAttribute("disabled"),
                            );
                            const target = event.key === "ArrowDown" ? items.at(0) : items.at(-1);
                            if (target) {
                              items.forEach((item) => (item.active = item === target));
                              target.focus({ preventScroll: true });
                            }
                            return;
                          }
                          // Keep editing keys out of Web Awesome's document-level
                          // menu handler; Escape still dismisses the whole menu.
                          if (event.key !== "Escape" && event.key !== "Tab") {
                            event.stopPropagation();
                          }
                        }}
                      />
                    </div>
                  `
                : nothing}
              ${rows.map((entry) => renderAgentRow(entry, params))}
              ${rows.length === 0
                ? html`<div class="sidebar-agent-menu__empty">
                    ${t("agentChip.noAgentMatches")}
                  </div>`
                : nothing}
              <div class="sidebar-customize-menu__separator" role="separator"></div>
            `
          : nothing}
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
        <div class="sidebar-customize-menu__separator" role="separator"></div>
        <wa-dropdown-item class="sidebar-customize-menu__item" value="command:settings">
          <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.settings}</span>
          <span class="sidebar-customize-menu__text">${titleForRoute("config")}</span>
        </wa-dropdown-item>
        <wa-dropdown-item
          class="sidebar-customize-menu__item sidebar-pair-mobile"
          value="command:pair-mobile"
          ?disabled=${!params.canPairDevice}
          title=${params.canPairDevice ? nothing : t("nodes.pairing.adminRequired")}
        >
          <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.smartphone}</span>
          <span class="sidebar-customize-menu__text">${t("nodes.pairing.button")}</span>
        </wa-dropdown-item>
        <wa-dropdown-item class="sidebar-customize-menu__item" value="command:apps">
          <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.layoutGrid}</span>
          <span class="sidebar-customize-menu__text">${t("agentChip.getApps")}</span>
        </wa-dropdown-item>
        <wa-dropdown-item
          class="sidebar-customize-menu__item sidebar-agent-menu__help"
          value="command:help"
        >
          <span slot="icon" class="nav-item__icon" aria-hidden="true"
            >${icons.circleQuestionMark}</span
          >
          <span class="sidebar-customize-menu__text">${t("agentChip.help")}</span>
          ${renderAgentMenuHelpSubmenu()}
        </wa-dropdown-item>
        <div class="sidebar-customize-menu__separator" role="separator"></div>
        <div class="sidebar-agent-menu__footer">
          <openclaw-sidebar-build-chip
            .basePath=${params.basePath}
            .gatewayVersion=${params.gatewayVersion}
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
    </openclaw-menu-surface>
  `;
}
