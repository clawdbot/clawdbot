import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import { createSessionEventRefreshCoordinator } from "../../lib/sessions/event-refresh-coordinator.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { createSessionEventSubscriptionOwner } from "../../lib/sessions/session-event-subscription.ts";
import { buildSessionListParams } from "../../lib/sessions/session-requests.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { selectableAgentsList } from "./display.ts";
import { agentRosterCards } from "./roster-activity.ts";

export abstract class AgentRosterElement extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  protected context!: ApplicationContext;
  @state() protected subscriptionError: string | null = null;

  protected readonly avatars = new IdentityAvatarController(this);
  protected readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.events.reset();
      this.refreshEvents.reset();
      this.subscriptionError = null;
      void this.roster.run([null]);
    },
    ensureInitialData: () => void this.refresh(),
  });
  private readonly events = createSessionEventSubscriptionOwner({
    isCurrent: (scope) => this.gateway.isCurrent(scope),
    onError: (_scope, error) => {
      this.subscriptionError = error;
    },
    retryDelayMs: () => null,
  });
  private readonly refreshEvents = createSessionEventRefreshCoordinator({
    active: true,
    refresh: () => this.refresh(),
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) =>
      gateway.subscribeEvents((event) => {
        if (
          this.gateway.connected &&
          this.context.gateway === gateway &&
          (event.event === "sessions.changed" || event.event === "session.message")
        ) {
          this.refreshEvents.schedule();
        }
      }),
  );
  protected readonly roster = new Task(this, {
    autoRun: false,
    task: async ([client]: [GatewayBrowserClient | null], { signal }) => {
      if (!client) {
        return initialState;
      }
      const raw = await this.context.agents.ensureList();
      signal.throwIfAborted();
      if (!raw) {
        throw new Error(this.context.agents.state.agentsError ?? t("agentsHome.loadFailed"));
      }
      const agents = selectableAgentsList(raw);
      await this.context.agentIdentity.ensure(agents.agents.map((agent) => agent.id));
      signal.throwIfAborted();
      const sessions: GatewaySessionRow[] = [];
      let offset = 0;
      // Bound every refresh to three pages (300 recent sessions), including previews.
      for (let page = 0; page < 3; page += 1) {
        const result = await client.request<SessionsListResult>(
          "sessions.list",
          buildSessionListParams({ includeLastMessage: true, limit: 100, offset }),
          { signal },
        );
        signal.throwIfAborted();
        sessions.push(...result.sessions);
        if (!result.hasMore || result.sessions.length === 0) {
          break;
        }
        offset = result.nextOffset ?? offset + result.sessions.length;
      }
      return { agents, sessions };
    },
  });

  protected refresh(): Promise<void> {
    const scope = this.gateway.capture();
    if (!scope) {
      return Promise.resolve();
    }
    void this.events.ensure(scope);
    return this.roster.run([scope.client]);
  }

  override disconnectedCallback() {
    this.events.dispose();
    this.refreshEvents.dispose();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  protected cards() {
    return agentRosterCards(this.roster.value?.agents, this.roster.value?.sessions ?? [], (id) =>
      this.context.agentIdentity.get(id),
    ).map((card) =>
      Object.assign(card, {
        avatar: card.avatar ? this.avatars.resolve(card.avatar) : null,
        target: sessionNavigationTarget({
          context: this.context,
          face: "chat",
          sessionKey: card.mainKey,
          agentId: card.id,
        }),
      }),
    );
  }
}
