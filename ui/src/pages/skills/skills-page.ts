import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, SkillStatusReport } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForPluginsHubTab } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
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
import {
  PLUGINS_HUB_PANEL_ID,
  pluginsHubTabs,
  type PluginsHubTab,
} from "../plugins/plugins-hub.ts";
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
  private debouncedClawHubSearchQuery = "";
  private readonly agentsTask = new Task(this, {
    autoRun: false,
    args: () =>
      [
        this.connected ? this.client : null,
        this.connected ? (this.context?.agents ?? null) : null,
      ] as const,
    task: ([client, agents]) => (client && agents ? agents.ensureList() : initialState),
    onComplete: (agents) => {
      if (!agents) {
        return;
      }
      this.agentsList = agents;
      const previousAgentId = this.skillsAgentId;
      reconcileSkillsAgentId(this, agents);
      if (previousAgentId !== this.skillsAgentId) {
        this.skillsDetailKey = null;
        this.skillsDetailTab = "overview";
      }
    },
    onError: (error) => {
      this.agentsError = String(error);
    },
  });
  private readonly clawhubSearchTask = new Task(this, {
    autoRun: false,
    args: () => [this.connected ? this.client : null, this.debouncedClawHubSearchQuery] as const,
    task: ([client, query], { signal }) =>
      client && query ? searchClawHub(client, query, signal) : initialState,
  });
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
    const connectionChanged = (snapshot.phase === "connected") !== this.connected;
    this.client = snapshot.client;
    this.connected = snapshot.phase === "connected";
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
    void this.agentsTask.run([null, null]);
    void this.clawhubSearchTask.run([null, ""]);
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
    this.debouncedClawHubSearchQuery = "";
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
    this.connected = snapshot.phase === "connected";
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
      this.clawhubSearchTask.status !== TaskStatus.PENDING &&
      this.clawhubSearchResults === null &&
      this.clawhubSearchError === null
    ) {
      this.runClawHubSearch(this.clawhubSearchQuery);
    }
  }

  private async loadAgents() {
    const client = this.client;
    if (!client || !this.connected || this.agentsLoading) {
      return;
    }
    const agentsSource = this.context.agents;
    if (agentsSource.state.agentsList) {
      this.syncAgentState();
      return;
    }
    this.agentsError = null;
    await this.agentsTask.run([client, agentsSource]);
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
    this.clawhubSearchQuery = query;
    this.clawhubInstallMessage = null;
    this.debouncedClawHubSearchQuery = "";
    void this.clawhubSearchTask.run([null, ""]);
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
    }
    this.clawhubSearchTimer = setTimeout(() => this.runClawHubSearch(query), 300);
  }

  private runClawHubSearch(query: string) {
    const normalizedQuery = query.trim();
    this.debouncedClawHubSearchQuery = normalizedQuery;
    if (!normalizedQuery || !this.connected || !this.client) {
      void this.clawhubSearchTask.run([null, ""]);
      return;
    }
    void this.clawhubSearchTask.run([this.client, normalizedQuery]);
  }

  get clawhubSearchResults(): ClawHubSearchResult[] | null {
    return this.clawhubSearchTask.status === TaskStatus.COMPLETE &&
      this.debouncedClawHubSearchQuery === this.clawhubSearchQuery.trim()
      ? (this.clawhubSearchTask.value ?? null)
      : null;
  }

  get clawhubSearchLoading(): boolean {
    return (
      this.debouncedClawHubSearchQuery.length > 0 &&
      this.clawhubSearchTask.status === TaskStatus.PENDING
    );
  }

  get clawhubSearchError(): string | null {
    if (
      this.clawhubSearchTask.status !== TaskStatus.ERROR ||
      this.debouncedClawHubSearchQuery !== this.clawhubSearchQuery.trim()
    ) {
      return null;
    }
    const error = this.clawhubSearchTask.error;
    return error instanceof Error ? error.message : String(error);
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
    this.context.navigate("plugins", {
      pathname: pathForPluginsHubTab(tab, this.context.basePath),
    });
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
          ${renderHubTabs({
            id: "plugins",
            active: "skills",
            tabs: pluginsHubTabs(),
            ariaLabel: t("pluginsPage.hubTablistLabel"),
            panelId: PLUGINS_HUB_PANEL_ID,
            className: "plugins-tabs",
            onSelect: (tab) => this.selectHubTab(tab),
          })}
        </div>
        <wa-tab-panel
          id=${PLUGINS_HUB_PANEL_ID}
          name="skills"
          active
          aria-labelledby="plugins-tab-skills"
        >
          ${renderSkills({
            connected: this.connected,
            loading:
              this.skillsLoading ||
              this.agentsLoading ||
              this.agentsTask.status === TaskStatus.PENDING,
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
