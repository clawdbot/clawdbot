import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, SkillStatusReport } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import {
  closeClawHubDetail,
  installFromClawHub,
  installSkill,
  loadClawHubDetail,
  loadSkillCard,
  loadSkills,
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
  type SkillMessageMap,
} from "../../lib/skills/index.ts";
import { renderSkills, type SkillDetailTab, type SkillsStatusFilter } from "./view.ts";

export type SkillsRouteData = {
  connected: boolean;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  report: SkillStatusReport | null;
  error: string | null;
};

class SkillsPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
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
  @state() skillsBusyKey: string | null = null;
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
  @state() clawhubInstallSlug: string | null = null;
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

  private stopGatewaySubscription?: () => void;
  private stopAgentsSubscription?: () => void;
  private clawhubSearchTimer: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.syncGatewayState();
    this.stopGatewaySubscription = this.context.gateway.subscribe(() => {
      const previousClient = this.client;
      this.syncGatewayState();
      if (previousClient !== this.client) {
        this.resetLoadedSkillState();
      }
      this.ensureInitialData();
    });
    this.stopAgentsSubscription = this.context.agents.subscribe(() => {
      this.syncAgentState();
      this.requestUpdate();
    });
    this.syncAgentState();
    this.ensureInitialData();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
    }
  }

  override disconnectedCallback() {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopAgentsSubscription?.();
    this.stopAgentsSubscription = undefined;
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
      this.clawhubSearchTimer = null;
    }
    super.disconnectedCallback();
  }

  private syncGatewayState() {
    const gateway = this.context.gateway.snapshot;
    this.client = gateway.client;
    this.connected = gateway.connected;
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
    this.agentsLoading = false;
    this.agentsError = null;
    this.agentsList = null;
    this.skillsAgentId = null;
    this.skillsAgentRevision++;
    this.skillsLoading = false;
    this.skillsReport = null;
    this.skillsError = null;
    this.skillsBusyKey = null;
    this.skillEdits = {};
    this.skillMessages = {};
    this.skillsDetailKey = null;
    this.skillsDetailTab = "overview";
    this.clawhubInstallSlug = null;
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
    if (this.skillsAgentId && data.selectedAgentId && data.selectedAgentId !== this.skillsAgentId) {
      return;
    }
    this.connected = data.connected;
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
    if (this.routeData?.agentsList || this.routeData?.report || this.routeData?.error) {
      return;
    }
    if (!this.agentsList && !this.agentsLoading) {
      void this.loadAgents();
    }
    if (!this.skillsReport && !this.skillsLoading) {
      void loadSkills(this);
    }
  }

  private async loadAgents() {
    const client = this.client;
    if (!client || !this.connected || this.agentsLoading) {
      return;
    }
    if (this.context.agents.state.agentsList) {
      this.syncAgentState();
      return;
    }
    this.agentsLoading = true;
    this.agentsError = null;
    try {
      const agents = await this.context.agents.ensureList();
      if (this.client !== client) {
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
      if (this.client === client) {
        this.agentsError = String(err);
      }
    } finally {
      if (this.client === client) {
        this.agentsLoading = false;
      }
    }
  }

  private async refreshPage() {
    await this.loadAgents();
    await loadSkills(this, { clearMessages: true });
  }

  private changeAgent(agentId: string) {
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

  override render() {
    const error = this.skillsError ?? this.agentsError;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("skills")}</div>
          <div class="page-sub">${subtitleForRoute("skills")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        this.context.basePath,
        renderSkills({
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
          busyKey: this.skillsBusyKey,
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
          clawhubInstallSlug: this.clawhubInstallSlug,
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
        }),
        "skills",
        (routeId) => this.context.navigate(routeId),
        (routeId) => this.context.preload(routeId),
        { hostPolicy: this.context.hostPolicy },
      )}
    `;
  }
}

if (!customElements.get("openclaw-skills-page")) {
  customElements.define("openclaw-skills-page", SkillsPage);
}
