import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, SkillStatusReport } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { renderPluginsHubTabs, type PluginsHubTab } from "../../components/plugins-hub-tabs.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import {
  closeClawHubDetail,
  installFromClawHub,
  installSkill,
  loadClawHubDetail,
  loadSkillCard,
  loadSkills,
  refreshSkills,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  searchClawHub,
  setClawHubSearchQuery,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
  type ClawHubSearchResult,
  type ClawHubSkillDetail,
  type ClawHubSkillSecurityVerdict,
  type SkillOperation,
  type SkillMessageMap,
} from "../../lib/skills/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderSkills, type SkillDetailTab, type SkillsStatusFilter } from "./view.ts";

export type SkillsRouteData = {
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  agents: ApplicationContext["agents"];
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  report: SkillStatusReport | null;
  error: string | null;
};

class SkillsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: SkillsRouteData;

  @state() client: GatewayBrowserClient | null = null;
  @state() connected = false;
  @state() agentsLoading = false;
  @state() agentsError: string | null = null;
  @state() agentsList: AgentsListResult | null = null;
  @state() skillsAgentId: string | null = null;
  @state() skillsAgentRevision = 0;
  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillOperation: SkillOperation = null;
  @state() skillsFilter = "";
  @state() skillsStatusFilter: SkillsStatusFilter = "all";
  @state() skillEdits: Record<string, string> = {};
  @state() skillMessages: SkillMessageMap = {};
  @state() skillsDetailKey: string | null = null;
  @state() skillsDetailTab: SkillDetailTab = "overview";
  @state() clawhubSearchQuery = "";
  @state() clawhubSearchResults: ClawHubSearchResult[] | null = null;
  @state() clawhubSearchLoading = false;
  @state() clawhubSearchError: string | null = null;
  @state() clawhubDetail: ClawHubSkillDetail | null = null;
  @state() clawhubDetailSlug: string | null = null;
  @state() clawhubDetailLoading = false;
  @state() clawhubDetailError: string | null = null;
  @state() clawhubInstallMessage: {
    kind: "success" | "error";
    text: string;
    acknowledgeSlug?: string;
    acknowledgeVersion?: string;
    acknowledgeLabel?: string;
  } | null = null;
  @state() clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict> = {};
  @state() clawhubVerdictsLoading = false;
  @state() clawhubVerdictsError: string | null = null;
  @state() skillCardContents: Record<string, string> = {};
  @state() skillCardContentKeys: Record<string, string> = {};
  @state() skillCardLoadingKey: string | null = null;
  @state() skillCardErrors: Record<string, string> = {};

  private clawhubSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private routeDataInitialized = false;
  private routeDataEnabled = true;
  private hasBoundGatewaySource = false;
  private sourceGeneration = 0;
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const resetForSourceBind = this.hasBoundGatewaySource;
        this.hasBoundGatewaySource = true;
        const cleanup = gateway.subscribe((snapshot) => this.applyGatewaySnapshot(snapshot));
        this.applyGatewaySnapshot(gateway.snapshot, resetForSourceBind);
        return cleanup;
      },
    )
    .effect(
      () => this.context?.agents,
      (agents) => {
        const cleanup = agents.subscribe(() => {
          this.syncAgentState();
          this.requestUpdate();
        });
        this.syncAgentState();
        this.ensureInitialData();
        return cleanup;
      },
    );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.ensureInitialData();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
      this.clawhubSearchTimer = null;
    }
    this.resetLoadedSkillState();
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot, resetForSourceBind = false) {
    const clientChanged = resetForSourceBind || snapshot.client !== this.client;
    const connectionChanged = snapshot.connected !== this.connected;
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    if (clientChanged || connectionChanged) {
      this.resetLoadedSkillState();
    }
    this.ensureInitialData();
  }

  private syncAgentState() {
    const agentState = this.context.agents.state;
    this.agentsLoading = agentState.agentsLoading;
    this.agentsError = agentState.agentsError;
    this.agentsList = agentState.agentsList;
    if (agentState.agentsList) {
      const previousAgentId = this.skillsAgentId;
      reconcileSkillsAgentId(this, agentState.agentsList);
      if (previousAgentId !== this.skillsAgentId) {
        this.skillsDetailKey = null;
        this.skillsDetailTab = "overview";
      }
    }
  }

  private resetLoadedSkillState() {
    this.sourceGeneration++;
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
      this.clawhubSearchTimer = null;
    }
    if (this.routeDataInitialized) {
      this.routeDataEnabled = false;
    }
    this.agentsLoading = false;
    this.agentsError = null;
    this.agentsList = null;
    this.skillsAgentId = null;
    this.skillsAgentRevision++;
    this.skillsLoading = false;
    this.skillsReport = null;
    this.skillsError = null;
    this.skillOperation = null;
    this.skillEdits = {};
    this.skillMessages = {};
    this.skillsDetailKey = null;
    this.skillsDetailTab = "overview";
    this.clawhubSearchResults = null;
    this.clawhubSearchLoading = false;
    this.clawhubSearchError = null;
    this.clawhubDetail = null;
    this.clawhubDetailSlug = null;
    this.clawhubDetailLoading = false;
    this.clawhubDetailError = null;
    this.clawhubInstallMessage = null;
    this.clawhubVerdicts = {};
    this.clawhubVerdictsLoading = false;
    this.clawhubVerdictsError = null;
    this.skillCardContents = {};
    this.skillCardContentKeys = {};
    this.skillCardLoadingKey = null;
    this.skillCardErrors = {};
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    this.routeDataEnabled = true;
    const gateway = this.context.gateway;
    const snapshot = gateway.snapshot;
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    if (
      data.gateway !== gateway ||
      data.gatewaySnapshot !== snapshot ||
      data.agents !== this.context.agents
    ) {
      this.routeDataEnabled = false;
      return;
    }
    if (this.skillsAgentId && data.selectedAgentId && data.selectedAgentId !== this.skillsAgentId) {
      return;
    }
    this.agentsLoading = false;
    this.agentsError = null;
    this.agentsList = data.agentsList ?? this.context.agents.state.agentsList;
    this.skillsAgentId = data.selectedAgentId ?? this.skillsAgentId;
    this.skillsLoading = false;
    this.skillsReport = data.report;
    this.skillsError = data.error;
  }

  private ensureInitialData() {
    if (!this.connected || !this.client) {
      return;
    }
    if (
      this.routeDataEnabled &&
      (this.routeData?.agentsList || this.routeData?.report || this.routeData?.error)
    ) {
      return;
    }
    if (!this.agentsList && !this.agentsLoading) {
      void this.loadAgents();
    }
    if (!this.skillsReport && !this.skillsLoading) {
      void loadSkills(this);
    }
    if (
      this.clawhubSearchQuery.trim() &&
      !this.clawhubSearchLoading &&
      !this.clawhubSearchResults &&
      !this.clawhubSearchError
    ) {
      void searchClawHub(this, this.clawhubSearchQuery);
    }
  }

  private async loadAgents() {
    const client = this.client;
    if (!client || !this.connected || this.agentsLoading) {
      return;
    }
    const gatewaySource = this.context.gateway;
    const agentsSource = this.context.agents;
    const sourceGeneration = this.sourceGeneration;
    const isCurrent = () =>
      this.isConnected &&
      this.connected &&
      this.client === client &&
      this.context.gateway === gatewaySource &&
      this.context.agents === agentsSource &&
      this.sourceGeneration === sourceGeneration;
    if (agentsSource.state.agentsList) {
      this.syncAgentState();
      return;
    }
    this.agentsLoading = true;
    this.agentsError = null;
    try {
      const agents = await agentsSource.ensureList();
      if (!isCurrent()) {
        return;
      }
      this.agentsList = agents;
      const previousAgentId = this.skillsAgentId;
      reconcileSkillsAgentId(this, agents);
      if (previousAgentId !== this.skillsAgentId) {
        this.skillsDetailKey = null;
        this.skillsDetailTab = "overview";
      }
    } catch (err) {
      if (isCurrent()) {
        this.agentsError = String(err);
      }
    } finally {
      if (isCurrent()) {
        this.agentsLoading = false;
      }
    }
  }

  private async refreshPage() {
    await refreshSkills(this, () => this.loadAgents());
  }

  private changeAgent(agentId: string) {
    if (this.skillOperation || this.skillsLoading) {
      return;
    }
    const previousAgentId = this.skillsAgentId;
    setSkillsAgentId(this, agentId);
    if (previousAgentId !== this.skillsAgentId) {
      this.skillsDetailKey = null;
      this.skillsDetailTab = "overview";
    }
    void loadSkills(this, { clearMessages: true });
  }

  private changeClawHubQuery(query: string) {
    setClawHubSearchQuery(this, query);
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
    }
    this.clawhubSearchTimer = setTimeout(() => void searchClawHub(this, query), 300);
  }

  private changeDetailTab(tab: SkillDetailTab) {
    this.skillsDetailTab = tab;
    if (tab === "card" && this.skillsDetailKey) {
      void loadSkillCard(this, this.skillsDetailKey);
    }
  }

  private selectHubTab(tab: PluginsHubTab) {
    if (tab === "skills") {
      return;
    }
    if (tab === "workshop") {
      this.context.navigate("skill-workshop");
      return;
    }
    this.context.navigate("plugins", tab === "discover" ? { search: "?tab=discover" } : undefined);
  }

  override render() {
    const error = this.skillsError ?? this.agentsError;
    return html`
      <section class="content-header content-header--page plugins-content-header">
        <div>
          <h1 class="page-title">${titleForRoute("skills")}</h1>
        </div>
      </section>
      ${renderSettingsWorkspace(html`
        <div class="plugins-hub-tabs-row">
          ${renderPluginsHubTabs({ active: "skills", onSelect: (tab) => this.selectHubTab(tab) })}
        </div>
        <wa-tab-panel
          id="plugins-hub-panel"
          name="skills"
          active
          aria-labelledby="plugins-tab-skills"
        >
          ${renderSkills({
            connected: this.connected,
            loading: this.skillsLoading || this.agentsLoading,
            report: this.skillsReport,
            agentsList: this.agentsList,
            selectedAgentId: this.skillsAgentId ?? this.agentsList?.defaultId ?? null,
            error,
            filter: this.skillsFilter,
            statusFilter: this.skillsStatusFilter,
            edits: this.skillEdits,
            messages: this.skillMessages,
            operation: this.skillOperation,
            detailKey: this.skillsDetailKey,
            detailTab: this.skillsDetailTab,
            clawhubVerdicts: this.clawhubVerdicts,
            clawhubVerdictsLoading: this.clawhubVerdictsLoading,
            clawhubVerdictsError: this.clawhubVerdictsError,
            skillCardContents: this.skillCardContents,
            skillCardLoadingKey: this.skillCardLoadingKey,
            skillCardErrors: this.skillCardErrors,
            clawhubQuery: this.clawhubSearchQuery,
            clawhubResults: this.clawhubSearchResults,
            clawhubSearchLoading: this.clawhubSearchLoading,
            clawhubSearchError: this.clawhubSearchError,
            clawhubDetail: this.clawhubDetail,
            clawhubDetailSlug: this.clawhubDetailSlug,
            clawhubDetailLoading: this.clawhubDetailLoading,
            clawhubDetailError: this.clawhubDetailError,
            clawhubInstallMessage: this.clawhubInstallMessage,
            onAgentChange: (agentId) => this.changeAgent(agentId),
            onFilterChange: (next) => (this.skillsFilter = next),
            onStatusFilterChange: (next) => (this.skillsStatusFilter = next),
            onRefresh: () => void this.refreshPage(),
            onToggle: (key, enabled) => void updateSkillEnabled(this, key, enabled),
            onEdit: (key, value) => updateSkillEdit(this, key, value),
            onSaveKey: (key) => void saveSkillApiKey(this, key),
            onInstall: (skillKey, name, installId) =>
              void installSkill(this, skillKey, name, installId),
            onDetailOpen: (key) => {
              this.skillsDetailKey = key;
              this.skillsDetailTab = "overview";
            },
            onDetailClose: () => (this.skillsDetailKey = null),
            onDetailTabChange: (tab) => this.changeDetailTab(tab),
            onClawHubQueryChange: (query) => this.changeClawHubQuery(query),
            onClawHubDetailOpen: (slug) => void loadClawHubDetail(this, slug),
            onClawHubDetailClose: () => closeClawHubDetail(this),
            onClawHubInstall: (slug, acknowledgeClawHubRisk, version) =>
              void installFromClawHub(this, slug, acknowledgeClawHubRisk, version),
          })}
        </wa-tab-panel>
      `)}
    `;
  }
}

if (!customElements.get("openclaw-skills-page")) {
  customElements.define("openclaw-skills-page", SkillsPage);
}
