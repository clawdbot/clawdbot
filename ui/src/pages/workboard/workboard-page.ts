import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { resetDraftState } from "../../lib/workboard/card-state.ts";
import {
  configureWorkboardPolling,
  loadWorkboard,
  stopWorkboardLifecycleRefresh,
  stopWorkboardPolling,
  syncWorkboardLifecycle,
} from "../../lib/workboard/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { matchesAgentScope } from "./agent-filter.ts";
import { renderWorkboard } from "./view.ts";

class WorkboardPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  private readonly requestPageUpdate = () => this.context?.workboard.notify();
  private observedAgentScopeId: string | null | undefined;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .effect(
      () => this.context?.agentSelection,
      (selection) => {
        const sync = () => this.syncWorkboardAgentScope();
        sync();
        return selection.subscribe(sync);
      },
    )
    .effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        const handleChange = () => {
          this.requestUpdate();
          this.ensureInitialData();
        };
        handleChange();
        return runtimeConfig.subscribe(handleChange);
      },
    )
    .watch(
      () => this.context?.sessions,
      (sessions, notify) => sessions.subscribe(notify),
    )
    .effect(
      () => this.context?.workboard,
      (workboard) => {
        this.syncWorkboardAgentScope();
        const unsubscribe = workboard.subscribe(() => this.requestUpdate());
        return () => {
          unsubscribe();
          stopWorkboardPolling(workboard);
          stopWorkboardLifecycleRefresh(workboard);
        };
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const handleSnapshot = (snapshot: ApplicationContext["gateway"]["snapshot"]) => {
          if (snapshot.connected && snapshot.client) {
            this.ensureInitialData();
          }
          this.requestUpdate();
        };
        handleSnapshot(gateway.snapshot);
        return gateway.subscribe(handleSnapshot);
      },
    );

  override connectedCallback() {
    super.connectedCallback();
    this.ensureInitialData();
    this.syncWorkboardRuntime();
  }

  override updated() {
    this.syncWorkboardRuntime();
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private ensureInitialData() {
    const context = this.context;
    const gateway = context?.gateway.snapshot;
    if (!context || !gateway?.connected || !gateway.client) {
      return;
    }
    if (!context.runtimeConfig.state.configSnapshot && !context.runtimeConfig.state.configLoading) {
      void context.runtimeConfig.ensureLoaded();
    }
    if (!context.agents.state.agentsList && !context.agents.state.agentsLoading) {
      void context.agents.ensureList();
    }
    if (!context.sessions.state.result && !context.sessions.state.loading) {
      void context.sessions.refresh();
    }
  }

  private pluginEnabled(): boolean | null {
    const snapshot = this.context?.runtimeConfig.state.configSnapshot;
    return snapshot ? isWorkboardEnabledInConfigSnapshot(snapshot) : null;
  }

  private syncWorkboardRuntime() {
    const context = this.context;
    const gateway = context?.gateway.snapshot;
    const pluginEnabled = this.pluginEnabled();
    if (!context || !gateway?.connected || !gateway.client || pluginEnabled !== true) {
      if (context) {
        stopWorkboardPolling(context.workboard);
        stopWorkboardLifecycleRefresh(context.workboard);
      }
      return;
    }
    const state = context.workboard.state;
    configureWorkboardPolling({
      host: context.workboard,
      client: gateway.client,
      enabled: state.autoRefreshIntervalMs > 0,
      requestUpdate: this.requestPageUpdate,
    });
    void loadWorkboard({
      host: context.workboard,
      client: gateway.client,
      requestUpdate: this.requestPageUpdate,
      refreshDiagnostics: hasOperatorWriteAccess(gateway.hello?.auth ?? null),
    });
    if (!state.pollRefreshInProgress && !state.dispatching) {
      void syncWorkboardLifecycle({
        host: context.workboard,
        client: gateway.client,
        sessions: context.sessions.state.result?.sessions ?? [],
        canWrite: hasOperatorWriteAccess(gateway.hello?.auth ?? null),
        requestUpdate: this.requestPageUpdate,
      });
    }
  }

  private reloadConfig() {
    const context = this.context;
    if (!context) {
      return;
    }
    void context.runtimeConfig.refresh({ discardPendingChanges: true });
  }

  private syncWorkboardAgentScope() {
    const context = this.context;
    if (!context) {
      return;
    }
    const nextScopeId = context.agentSelection.state.scopeId;
    if (this.observedAgentScopeId !== nextScopeId) {
      this.observedAgentScopeId = nextScopeId;
      const state = context.workboard.state;
      const agentsList = context.agents.state.agentsList;
      const remainsVisible = (cardId: string) => {
        const card = state.cards.find((entry) => entry.id === cardId);
        return Boolean(card && matchesAgentScope(card, agentsList, nextScopeId));
      };
      // The board's richer agent filter is a secondary control available only
      // in all-agent scope; a chip switch must not retain a hidden subfilter.
      state.agentFilter = "all";
      if (state.detailCardId && !remainsVisible(state.detailCardId)) {
        state.detailCardId = null;
        state.detailCommentBody = "";
      }
      if (state.editingCardId && !remainsVisible(state.editingCardId)) {
        resetDraftState(state);
      }
      context.workboard.notify();
    }
  }

  override render() {
    const context = this.context;
    if (!context) {
      return nothing;
    }
    const gateway = context.gateway.snapshot;
    const config = context.runtimeConfig.state;
    const auth = gateway.hello?.auth ?? null;
    const pluginEnabled = this.pluginEnabled();
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("workboard")}</div>
        </div>
        ${renderAgentScopeControl({
          agents: context.agents.state.agentsList?.agents ?? [],
          selection: context.agentSelection,
        })}
      </section>
      ${renderWorkboard({
        host: context.workboard,
        client: gateway.client,
        connected: gateway.connected,
        canWrite: hasOperatorWriteAccess(auth),
        canModelOverride: hasOperatorAdminAccess(auth),
        pluginEnabled,
        pluginEnablementError:
          !config.configSnapshot && !config.configLoading ? config.lastError : null,
        agentsList: context.agents.state.agentsList,
        sessions: context.sessions.state.result?.sessions ?? [],
        scopeAgentId: context.agentSelection.state.scopeId,
        showAgentFilter: context.agentSelection.state.scopeId === null,
        onOpenSession: (sessionKey) => {
          context.navigate("chat", { search: searchForSession(sessionKey), hash: "" });
        },
        onReloadConfig: () => this.reloadConfig(),
        onRequestUpdate: this.requestPageUpdate,
      })}
    `;
  }
}

if (!customElements.get("openclaw-workboard-page")) {
  customElements.define("openclaw-workboard-page", WorkboardPage);
}
