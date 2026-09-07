import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import {
  normalizeAgentLabel,
  resolveAgentTextAvatar,
  selectableAgentsList,
} from "../../lib/agents/display.ts";
import { deriveAvatarInitial, resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { createSessionEventRefreshCoordinator } from "../../lib/sessions/event-refresh-coordinator.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { createSessionEventSubscriptionOwner } from "../../lib/sessions/session-event-subscription.ts";
import { buildAgentMainSessionKey, parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { buildSessionListParams } from "../../lib/sessions/session-requests.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderAgentsHome } from "./view.ts";

export class AgentsHomePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @state() private subscriptionError: string | null = null;

  private readonly avatars = new IdentityAvatarController(this);
  private readonly gateway = new GatewayPageController(this, {
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
  private readonly roster = new Task(this, {
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

  private refresh(): Promise<void> {
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

  override render() {
    const data = this.roster.value;
    return this.avatars.withActiveRoutes(() => {
      const cards = (data?.agents.agents ?? [])
        .map((agent) => {
          const identity = this.context.agentIdentity.get(agent.id);
          const name = normalizeAgentLabel(agent, identity);
          const mainKey = buildAgentMainSessionKey({
            agentId: agent.id,
            mainKey: data?.agents.mainKey,
          });
          const sessions = (data?.sessions ?? []).filter(
            (session) =>
              (session.agentId ?? parseAgentSessionKey(session.key)?.agentId) === agent.id,
          );
          const recent = sessions.reduce<GatewaySessionRow | undefined>(
            (latest, session) =>
              !latest || (session.updatedAt ?? 0) > (latest.updatedAt ?? 0) ? session : latest,
            undefined,
          );
          const main =
            sessions.find((session) => session.key === mainKey) ??
            sessions.find((session) => session.isMain);
          const avatarUrl = resolveAgentAvatarUrl(agent, identity);
          return {
            id: agent.id,
            name,
            role: agent.identity?.theme,
            model: agent.model?.primary,
            avatar: avatarUrl ? this.avatars.resolve(avatarUrl) : null,
            fallback: resolveAgentTextAvatar(agent, identity) ?? deriveAvatarInitial(name),
            activeNow: sessions.some(isSessionRunActive),
            lastActiveAt: recent?.updatedAt ?? 0,
            preview: (main ?? recent)?.lastMessagePreview,
            target: sessionNavigationTarget({
              context: this.context,
              face: "chat",
              sessionKey: mainKey,
              agentId: agent.id,
            }),
          };
        })
        .toSorted(
          (a, b) =>
            Number(b.activeNow) - Number(a.activeNow) ||
            b.lastActiveAt - a.lastActiveAt ||
            Number(b.id === data?.agents.defaultId) - Number(a.id === data?.agents.defaultId) ||
            a.id.localeCompare(b.id),
        );
      return renderAgentsHome({
        cards,
        context: this.context,
        connected: this.gateway.connected,
        loading: this.roster.status === TaskStatus.PENDING,
        error:
          this.roster.status === TaskStatus.ERROR
            ? formatUiError(this.roster.error, t("agentsHome.loadFailed"))
            : this.subscriptionError,
        onRetry: () => void this.refresh(),
        canCreate: canCallGatewayMethod(this.gateway.snapshot, "openclaw.chat", "operator.admin"),
      });
    });
  }
}

if (!customElements.get("openclaw-agents-home-page")) {
  customElements.define("openclaw-agents-home-page", AgentsHomePage);
}
