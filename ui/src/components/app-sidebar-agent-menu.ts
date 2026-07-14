// Sidebar agent-chip menu (switcher, filter, utility rows), split out of
// app-sidebar.ts to keep that hot component inside the TS LOC ratchet.
import { html, nothing } from "lit";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { icons, type IconName } from "./icons.ts";

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

type AgentMenuAgent = { id: string; name?: string; identity?: { name?: string; emoji?: string } };

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
  helpOpen: boolean;
  onHelpOpenChange: (next: boolean) => void;
  onFilterChange: (next: string) => void;
  onSwitchAgent: (agentId: string) => void;
  onAskCapabilities: (agentId: string) => void;
  onOpenNewSession: (agentId: string) => void;
  onClose: () => void;
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
  const initial = resolveAgentTextAvatar(agent) ?? (label || agent.id).slice(0, 1).toUpperCase();
  return html`
    <div class="sidebar-agent-menu__agent-row">
      <button
        type="button"
        class="sidebar-customize-menu__item sidebar-agent-menu__agent-switch"
        role="menuitemradio"
        tabindex="-1"
        aria-checked=${String(active)}
        @click=${() => params.onSwitchAgent(agentId)}
      >
        <span class="sidebar-agent-section__avatar" aria-hidden="true">${initial}</span>
        <span class="sidebar-customize-menu__text">${label}</span>
        ${unread > 0
          ? html`<span
              class="session-unread-dot"
              role="img"
              aria-label=${t("sessionsView.unread")}
            ></span>`
          : nothing}
        <span class="sidebar-customize-menu__check" aria-hidden="true">
          ${active ? icons.check : nothing}
        </span>
      </button>
      <button
        type="button"
        class="sidebar-session-sort sidebar-agent-menu__new"
        role="menuitem"
        tabindex="-1"
        title=${`${t("chat.runControls.newSession")} — ${label}`}
        aria-label=${`${t("chat.runControls.newSession")} — ${label}`}
        ?disabled=${!params.connected}
        @click=${() => {
          params.onClose();
          params.onOpenNewSession(agentId);
        }}
      >
        ${icons.plus}
      </button>
    </div>
  `;
}

// Prefer a right flyout, flip left when the right edge is tight, and on
// viewports too narrow for two side-by-side menus overlay the parent
// instead — a flipped submenu would land offscreen there. Menus are
// shrink-to-fit (224-264px, localized labels vary), so measure the open
// parent and budget the flyout at its max width; underestimating picks a
// side placement whose flyout clips past the viewport.
function agentMenuHelpPlacement(position: { x: number }): "" | "--left" | "--overlay" {
  const flyoutMaxWidth = 264;
  const parentWidth =
    document.querySelector(".sidebar-agent-menu")?.getBoundingClientRect().width ?? flyoutMaxWidth;
  const fitsRight = position.x + parentWidth + 4 + flyoutMaxWidth <= window.innerWidth - 8;
  const fitsLeft = position.x >= flyoutMaxWidth + 4 + 8;
  return fitsRight ? "" : fitsLeft ? "--left" : "--overlay";
}

function renderAgentMenuHelpSubmenu(position: { x: number }, params: SidebarAgentMenuParams) {
  const placement = agentMenuHelpPlacement(position);
  return html`
    <div
      class="sidebar-customize-menu sidebar-customize-menu__submenu ${placement
        ? `sidebar-customize-menu__submenu${placement}`
        : ""}"
      role="menu"
      aria-label=${t("agentChip.help")}
    >
      ${AGENT_MENU_LINKS.map(
        (link) => html`
          <a
            class="sidebar-customize-menu__item"
            role="menuitem"
            tabindex="-1"
            href=${link.href}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            @click=${() => params.onClose()}
          >
            <span class="nav-item__icon" aria-hidden="true">${icons[link.icon]}</span>
            <span class="sidebar-customize-menu__text">${link.label()}</span>
          </a>
        `,
      )}
    </div>
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
      <div
        class="sidebar-customize-menu sidebar-agent-menu"
        role="menu"
        aria-label=${t("agentChip.menuLabel")}
        style="left: ${position.x}px; bottom: ${position.bottom}px;"
      >
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
                      />
                    </div>
                  `
                : nothing}
              <div class="sidebar-agent-menu__list">
                ${rows.map((entry) => renderAgentRow(entry, params))}
                ${rows.length === 0
                  ? html`<div class="sidebar-agent-menu__empty">
                      ${t("agentChip.noAgentMatches")}
                    </div>`
                  : nothing}
              </div>
              <div class="sidebar-customize-menu__separator" role="separator"></div>
            `
          : nothing}
        <button
          type="button"
          class="sidebar-customize-menu__item"
          role="menuitem"
          tabindex="-1"
          ?disabled=${!params.connected}
          @click=${() => params.onAskCapabilities(activeId)}
        >
          <span class="nav-item__icon" aria-hidden="true">${icons.bot}</span>
          <span class="sidebar-customize-menu__text">
            ${t("agentChip.whatCanAgentDo", { name: activeName })}
          </span>
        </button>
        <button
          type="button"
          class="sidebar-customize-menu__item"
          role="menuitem"
          tabindex="-1"
          @click=${() => {
            params.onClose();
            params.onNavigate("agents", { search: `?agent=${encodeURIComponent(activeId)}` });
          }}
        >
          <span class="nav-item__icon" aria-hidden="true">${icons.users}</span>
          <span class="sidebar-customize-menu__text">${t("agentChip.agentSettings")}</span>
        </button>
        <div class="sidebar-customize-menu__separator" role="separator"></div>
        <button
          type="button"
          class="sidebar-customize-menu__item"
          role="menuitem"
          tabindex="-1"
          @click=${() => {
            params.onClose();
            params.onNavigate("config");
          }}
        >
          <span class="nav-item__icon" aria-hidden="true">${icons.settings}</span>
          <span class="sidebar-customize-menu__text">${titleForRoute("config")}</span>
        </button>
        <button
          type="button"
          class="sidebar-customize-menu__item sidebar-pair-mobile"
          role="menuitem"
          tabindex="-1"
          ?disabled=${!params.canPairDevice}
          title=${params.canPairDevice ? nothing : t("nodes.pairing.adminRequired")}
          @click=${() => {
            params.onClose();
            params.onPairMobile();
          }}
        >
          <span class="nav-item__icon" aria-hidden="true">${icons.smartphone}</span>
          <span class="sidebar-customize-menu__text">${t("nodes.pairing.button")}</span>
        </button>
        <div
          class="sidebar-customize-menu__submenu-host"
          @pointerenter=${(event: PointerEvent) => {
            // Hover open/close is mouse-only: on touch/pen taps the
            // enter/leave pair would race the click below. Overlay placement
            // covers this trigger row, so hover-opening there would land the
            // pending click on a flyout link instead.
            if (event.pointerType === "mouse" && agentMenuHelpPlacement(position) !== "--overlay") {
              params.onHelpOpenChange(true);
            }
          }}
          @pointerleave=${(event: PointerEvent) => {
            if (event.pointerType === "mouse") {
              params.onHelpOpenChange(false);
            }
          }}
        >
          <button
            type="button"
            class="sidebar-customize-menu__item"
            role="menuitem"
            tabindex="-1"
            aria-haspopup="menu"
            aria-expanded=${String(params.helpOpen)}
            @click=${() => {
              // Open-only: with hover-open, a toggle would close the flyout
              // on the very click that follows the opening pointerenter.
              // Closing happens by leaving the host or closing the menu.
              params.onHelpOpenChange(true);
            }}
          >
            <span class="nav-item__icon" aria-hidden="true">${icons.circleQuestionMark}</span>
            <span class="sidebar-customize-menu__text">${t("agentChip.help")}</span>
            <span class="sidebar-customize-menu__chevron" aria-hidden="true">
              ${icons.chevronRight}
            </span>
          </button>
          ${params.helpOpen ? renderAgentMenuHelpSubmenu(position, params) : nothing}
        </div>
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
      </div>
    </openclaw-menu-surface>
  `;
}
