import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { loadDashboardsRoute } from "./route.ts";
import { renderDashboards, type DashboardsRouteData } from "./view.ts";

class DashboardsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: DashboardsRouteData;

  private observedSessions?: ApplicationContext["sessions"];
  private observedAgentSelection?: ApplicationContext["agentSelection"];
  private observedDependencies = "";
  private dependenciesInitialized = false;
  private refreshGeneration = 0;
  private data?: DashboardsRouteData;
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.sessions,
      (sessions) => {
        this.synchronizeDependencies();
        return sessions.subscribe(() => this.synchronizeDependencies());
      },
    )
    .effect(
      () => this.context?.agentSelection,
      (agentSelection) => {
        this.synchronizeDependencies();
        return agentSelection.subscribe(() => this.synchronizeDependencies());
      },
    );

  override disconnectedCallback() {
    this.refreshGeneration += 1;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.data = this.routeData;
    }
  }

  private synchronizeDependencies(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const sessions = context.sessions;
    const agentSelection = context.agentSelection;
    const dependencies = `${agentSelection.state.scopeId ?? "all"}\u0000${
      sessions.canonicalListRevision
    }`;
    const sourceChanged =
      sessions !== this.observedSessions || agentSelection !== this.observedAgentSelection;
    if (
      this.dependenciesInitialized &&
      !sourceChanged &&
      dependencies === this.observedDependencies
    ) {
      return;
    }
    const shouldRefresh =
      context.gateway.snapshot.phase === "connected" &&
      (this.dependenciesInitialized ||
        (this.routeData?.result === null && this.routeData.error === null));
    this.dependenciesInitialized = true;
    this.observedSessions = sessions;
    this.observedAgentSelection = agentSelection;
    this.observedDependencies = dependencies;
    if (shouldRefresh) {
      void this.refresh(context, sessions, agentSelection, dependencies);
    }
  }

  private async refresh(
    context: ApplicationContext,
    sessions: ApplicationContext["sessions"],
    agentSelection: ApplicationContext["agentSelection"],
    dependencies: string,
  ): Promise<void> {
    const gateway = context.gateway;
    const client = gateway.snapshot.phase === "connected" ? gateway.snapshot.client : null;
    if (!client) {
      return;
    }
    const generation = ++this.refreshGeneration;
    const data = await loadDashboardsRoute(context);
    if (
      generation !== this.refreshGeneration ||
      this.context !== context ||
      context.sessions !== sessions ||
      context.agentSelection !== agentSelection ||
      this.observedDependencies !== dependencies ||
      context.gateway !== gateway ||
      gateway.snapshot.phase !== "connected" ||
      gateway.snapshot.client !== client ||
      (data.result === null && data.error === null)
    ) {
      return;
    }
    this.data = data;
    this.requestUpdate();
  }

  override render() {
    return renderDashboards(this.data);
  }
}

if (!customElements.get("openclaw-dashboards-page")) {
  customElements.define("openclaw-dashboards-page", DashboardsPage);
}
