import { TaskStatus } from "@lit/task";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { AgentRosterElement } from "../lib/agents/roster-element.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.ts";
import { icons } from "./icons.ts";
import "../styles/sidebar-agent-roster.css";

registerAgentsHomeEnglish();

class SidebarAgentRoster extends AgentRosterElement {
  @property({ attribute: false }) host!: AppSidebarRenderHost;
  @property({ attribute: false }) activeId = "";
  @property({ attribute: false }) unreadCounts = new Map<string, number>();
  @property({ attribute: false }) menuOpen = false;

  override render() {
    return this.avatars.withActiveRoutes(() => {
      const cards = this.cards();
      const error = this.roster.status === TaskStatus.ERROR || this.subscriptionError;
      return html`<section class="sidebar-agent-roster" aria-label=${t("agentChip.agents")}>
        <div class="sidebar-agent-roster__header">
          <span>${t("agentChip.agents")}</span>
          <button
            type="button"
            class="sidebar-brand__icon"
            aria-label=${t("agentChip.switchAgent")}
            aria-haspopup="menu"
            aria-expanded=${String(this.menuOpen)}
            @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
            @click=${(event: MouseEvent) => {
              event.stopPropagation();
              if (event.currentTarget instanceof HTMLElement) {
                this.host.sidebarMenus.toggleAgentMenu(event.currentTarget);
              }
            }}
          >
            ${icons.chevronsUpDown}
          </button>
        </div>
        ${error ? html`<button class="sidebar-agent-roster__link" @click=${() => void this.refresh()}>${t("agentsHome.loadFailed")}</button>` : nothing}
        ${repeat(
          cards.slice(0, 6),
          (card) => card.id,
          (card) => {
            const unread = this.unreadCounts.get(card.id) ?? 0;
            const activity = !this.gateway.connected
              ? t("agentsHome.disconnected")
              : card.activeNow
                ? t("agentsHome.workingPreview", {
                    preview: card.preview || t("agentsHome.noMessage"),
                  })
                : card.lastActiveAt
                  ? t("agentsHome.lastActive", { time: formatRelativeTimestamp(card.lastActiveAt) })
                  : t("agentsHome.neverActive");
            return html`<button
              type="button"
              class="sidebar-agent-roster__row"
              data-agent-id=${card.id}
              aria-pressed=${String(card.id === this.activeId)}
              @click=${() => this.host.switchChipAgent(card.id)}
            >
              <span class="sidebar-agent-roster__avatar" aria-hidden="true">
                ${card.avatar ? html`<img src=${card.avatar} alt="" loading="lazy" />` : card.fallback}
                <span
                  class="sidebar-agent-roster__status"
                  data-working=${String(this.gateway.connected && card.activeNow)}
                ></span>
              </span>
              <span class="sidebar-agent-roster__copy"
                ><span>${card.name}</span
                ><span class="sidebar-agent-roster__activity" title=${activity}
                  >${activity}</span
                ></span
              >
              ${unread > 0 ? html`<span class="sidebar-agent-roster__unread" aria-label=${t("sessionsView.unread")}>${unread}</span>` : nothing}
            </button>`;
          },
        )}
        <a
          class="sidebar-agent-roster__link"
          href=${pathForRoute("agents-home", this.host.basePath)}
          @click=${(event: MouseEvent) => {
            if (shouldHandleNavigationClick(event)) {
              event.preventDefault();
              this.host.onNavigate?.("agents-home");
            }
          }}
          >${cards.length > 6 ? t("agentsHome.seeAllCount", { count: String(cards.length) }) : t("agentsHome.seeAll")}</a
        >
        <a
          class="sidebar-agent-roster__link"
          href=${`${pathForRoute("custodian", this.host.basePath)}?intent=new-agent`}
          @click=${(event: MouseEvent) => {
            if (shouldHandleNavigationClick(event)) {
              event.preventDefault();
              this.host.onNavigate?.("custodian", { search: "?intent=new-agent" });
            }
          }}
          >${icons.plus}<span>${t("custodian.newAgent")}</span></a
        >
      </section>`;
    });
  }
}

customElements.define("openclaw-sidebar-agent-roster", SidebarAgentRoster);

export function renderSidebarAgentRoster(host: AppSidebarRenderHost) {
  // Native and external sidebar catalogs are agent-scoped and may be filtered.
  // The shared roster owner loads bounded cross-agent activity only while mounted.
  return html`<openclaw-sidebar-agent-roster
    .host=${host}
    .activeId=${host.expandedAgentId()}
    .menuOpen=${host.sidebarMenus.agentMenuPosition !== null}
    .unreadCounts=${new Map(host.activeChipAgent().agents.map((agent) => [agent.id, host.agentUnreadCount(agent.id)]))}
  ></openclaw-sidebar-agent-roster>`;
}
