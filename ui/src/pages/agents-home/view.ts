import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../../app/context.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import "../../styles/agents-home.css";

registerAgentsHomeEnglish();

type AgentCard = {
  id: string;
  name: string;
  role?: string;
  model?: string;
  avatar: string | null;
  fallback: string;
  activeNow: boolean;
  lastActiveAt: number;
  preview?: string | null;
  target: { href: string; options: ApplicationNavigationOptions };
};

type AgentsHomeProps = {
  cards: AgentCard[];
  context: ApplicationContext;
  connected: boolean;
  loading: boolean;
  error: string | null;
  canCreate: boolean;
  onRetry: () => void;
};

export function renderAgentsHome(props: AgentsHomeProps) {
  const { context } = props;
  const navigate = (event: MouseEvent, route: string, options?: ApplicationNavigationOptions) => {
    if (shouldHandleNavigationClick(event)) {
      event.preventDefault();
      context.navigate(route, options);
    }
  };
  const manage = html`<a
    class="btn"
    href=${pathForRoute("agents", context.basePath)}
    @click=${(event: MouseEvent) => navigate(event, "agents")}
    >${t("agentsHome.manage")}</a
  >`;
  return html` <div class="agents-home__header">
      ${renderSettingsPageHeader({
        title: titleForRoute("agents-home"),
        subtitle: subtitleForRoute("agents-home"),
        actions: html`${manage}
          <a
            class="btn primary"
            href=${props.canCreate ? `${pathForRoute("custodian", context.basePath)}?intent=new-agent` : pathForRoute("agents", context.basePath)}
            @click=${(event: MouseEvent) => navigate(event, props.canCreate ? "custodian" : "agents", props.canCreate ? { search: "?intent=new-agent" } : undefined)}
            >${t("agentsHome.create")}</a
          >`,
      })}
    </div>
    <section class="agents-home" aria-label=${titleForRoute("agents-home")}>
      ${!props.connected ? html`<div class="callout warn" role="status">${t("agentsHome.disconnected")}</div>` : nothing}
      ${
        props.connected && props.error
          ? html`<div class="callout danger" role="alert">
              ${props.error}
              <button class="btn btn--sm" @click=${props.onRetry}>${t("common.retry")}</button>
            </div>`
          : nothing
      }
      ${
        props.connected && props.loading && props.cards.length === 0
          ? html` <div
              role="status"
              aria-label=${t("agentsHome.loading")}
              class="agents-home__grid"
            >
              ${[0, 1, 2, 3].map(() => html`<div class="agents-home__skeleton" aria-hidden="true"></div>`)}
            </div>`
          : nothing
      }
      ${
        props.connected && !props.loading && !props.error && props.cards.length === 0
          ? html` <div class="agents-home__empty">
              <p>${t("agentsHome.empty")}</p>
              ${manage}
            </div>`
          : nothing
      }
      <div class="agents-home__grid">
        ${repeat(
          props.cards,
          (card) => card.id,
          (card) => html` <a
            class="agents-home__card"
            data-agent-id=${card.id}
            href=${card.target.href}
            @click=${(event: MouseEvent) => navigate(event, "chat", card.target.options)}
          >
            <div class="agents-home__identity">
              <div class="agents-home__avatar" aria-hidden="true">
                ${
                  card.avatar
                    ? html`<img
                        src=${card.avatar}
                        alt=""
                        loading="lazy"
                        @error=${(event: Event) => {
                          if (event.target instanceof HTMLImageElement) {
                            event.target.hidden = true;
                          }
                        }}
                      />`
                    : nothing
                }
                <span>${card.fallback}</span>
              </div>
              <div class="agents-home__name">
                <h2>${card.name}</h2>
                ${card.role ? html`<p>${card.role}</p>` : nothing}
              </div>
            </div>
            ${card.model ? html`<span class="agents-home__model" title=${card.model}>${card.model}</span>` : nothing}
            <div class="agents-home__activity">
              ${
                card.activeNow
                  ? html`<span class="agents-home__working">${t("agentsHome.working")}</span>`
                  : card.lastActiveAt
                    ? t("agentsHome.lastActive", {
                        time: formatRelativeTimestamp(card.lastActiveAt),
                      })
                    : t("agentsHome.neverActive")
              }
            </div>
            <p class="agents-home__preview" title=${card.preview ?? ""}>
              ${card.preview || t("agentsHome.noMessage")}
            </p>
            <span class="btn primary agents-home__open">${t("agentsHome.openChat")}</span>
          </a>`,
        )}
      </div>
    </section>`;
}
