import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
  SkillStatusReport,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { selectableAgentsList } from "../../lib/agents/display.ts";
import {
  loadToolsCatalog,
  loadToolsEffective,
  buildToolsEffectiveRequestKey,
  refreshVisibleToolsEffectiveForCurrentSession,
  resetToolsEffectiveState,
  setDefaultAgent,
  type AgentsPanel,
  type AgentsState,
} from "../../lib/agents/index.ts";
import { currentConfigObject, findAgentConfigEntryIndex } from "../../lib/config/index.ts";
import {
  createInitialCronState,
  loadCronJobsPage,
  loadCronStatus,
  runCronJob,
} from "../../lib/cron/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { normalizeStringEntries } from "../../lib/string-coerce.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { loadAgentFileContent, saveAgentFile } from "./files.ts";
import {
  resetIdentityDraft,
  saveIdentityDraft,
  selectIdentityAvatar,
  setIdentityDraftField,
  togglePinnedAgent,
} from "./identity-actions.ts";
import { stageAgentModelFallbacks, stageAgentPrimaryModel } from "./model-config.ts";
import type { AgentIdentityDraft } from "./panels-overview.ts";
import { loadAgentSkills } from "./skills.ts";
import { renderAgents } from "./view.ts";

export type AgentsRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  error: string | null;
};

type AgentsRequestSources = Partial<
  Pick<ApplicationContext, "agents" | "agentIdentity" | "sessions">
>;

class AgentsPage extends OpenClawLightDomElement implements AgentsState {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: AgentsRouteData;

  @state() client: GatewayBrowserClient | null = null;
  @state() connected = false;
  @state() agentsLoading = false;
  @state() agentsError: string | null = null;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsSelectedId: string | null = null;
  @state() agentsPanel: AgentsPanel = "files";
  @state() toolsCatalogLoading = false;
  @state() toolsCatalogLoadingAgentId: string | null = null;
  @state() toolsCatalogError: string | null = null;
  @state() toolsCatalogResult: ToolsCatalogResult | null = null;
  @state() toolsEffectiveLoading = false;
  @state() toolsEffectiveLoadingKey: string | null = null;
  @state() toolsEffectiveResultKey: string | null = null;
  @state() toolsEffectiveError: string | null = null;
  @state() toolsEffectiveResult: ToolsEffectiveResult | null = null;
  @state() chatModelCatalog: ModelCatalogEntry[] = [];
  @state() agentFilesLoading = false;
  @state() agentFilesError: string | null = null;
  @state() agentFilesList: AgentsFilesListResult | null = null;
  @state() agentFileContents: Record<string, string> = {};
  @state() agentFileDrafts: Record<string, string> = {};
  @state() agentFileActive: string | null = null;
  @state() agentFileSaving = false;
  @state() agentIdentityLoading = false;
  @state() agentIdentityError: string | null = null;
  @state() identityDraft: AgentIdentityDraft = { name: null, emoji: null, avatar: null };
  @state() identitySaving = false;
  @state() identityError: string | null = null;
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;
  @state() skillsFilter = "";
  @state() private cron = createInitialCronState();

  requestGeneration = 0;
  private routeDataInitialized = false;
  private hasBoundGateway = false;
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private hasBoundAgents = false;
  private agentsSource: ApplicationContext["agents"] | null = null;
  private hasBoundAgentIdentity = false;
  private agentIdentitySource: ApplicationContext["agentIdentity"] | null = null;
  private hasBoundSessions = false;
  private sessionsSource: ApplicationContext["sessions"] | null = null;
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.agents,
      (agents) => {
        const resetForSourceBind = this.hasBoundAgents;
        this.hasBoundAgents = true;
        this.agentsSource = agents;
        if (resetForSourceBind) {
          this.resetForAgentsSourceChange();
        }
        this.syncAgentState(agents);
        this.ensureInitialData();
        const stop = agents.subscribe(() => {
          if (this.agentsSource !== agents || this.context.agents !== agents) {
            return;
          }
          this.syncAgentState(agents);
          this.ensureAgentIdentities();
          this.loadActivePanelData();
          this.requestUpdate();
        });
        return () => {
          stop();
          if (this.agentsSource === agents) {
            this.agentsSource = null;
          }
        };
      },
    )
    .effect(
      () => this.context?.agentIdentity,
      (agentIdentity) => {
        const resetForSourceBind = this.hasBoundAgentIdentity;
        this.hasBoundAgentIdentity = true;
        this.agentIdentitySource = agentIdentity;
        if (resetForSourceBind) {
          this.invalidateTransientRequests();
          this.agentIdentityError = null;
        }
        this.ensureAgentIdentities();
        this.ensureInitialData();
        const stop = agentIdentity.subscribe(() => {
          if (
            this.agentIdentitySource === agentIdentity &&
            this.context.agentIdentity === agentIdentity
          ) {
            this.requestUpdate();
          }
        });
        return () => {
          stop();
          if (this.agentIdentitySource === agentIdentity) {
            this.agentIdentitySource = null;
          }
        };
      },
    )
    .watch(
      () => this.context?.channels,
      (channels, notify) => channels.subscribe(notify),
    )
    .watch(
      () => this.context?.navigation,
      (navigation, notify) => navigation.subscribe(notify),
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
    )
    .effect(
      () => this.context?.sessions,
      (sessions) => {
        const resetForSourceBind = this.hasBoundSessions;
        this.hasBoundSessions = true;
        this.sessionsSource = sessions;
        if (resetForSourceBind) {
          this.invalidateTransientRequests();
          resetToolsEffectiveState(this);
          this.loadActivePanelData();
        }
        const stop = sessions.subscribe(() => {
          if (this.sessionsSource !== sessions || this.context.sessions !== sessions) {
            return;
          }
          void refreshVisibleToolsEffectiveForCurrentSession(this);
          this.requestUpdate();
        });
        return () => {
          stop();
          if (this.sessionsSource === sessions) {
            this.sessionsSource = null;
          }
        };
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const initialBind = !this.hasBoundGateway;
        this.hasBoundGateway = true;
        this.gatewaySource = gateway;
        this.applyGatewaySnapshot(gateway.snapshot, !initialBind, initialBind);
        const stop = gateway.subscribe((snapshot) => {
          if (this.gatewaySource === gateway && this.context.gateway === gateway) {
            this.applyGatewaySnapshot(snapshot, false);
          }
        });
        return () => {
          stop();
          if (this.gatewaySource === gateway) {
            this.gatewaySource = null;
          }
        };
      },
    );

  get sessions() {
    return this.context.sessions;
  }

  get sessionsResult() {
    return this.context.sessions.state.result;
  }

  get sessionKey() {
    return this.context.gateway.snapshot.sessionKey;
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.requestGeneration += 1;
    this.client = null;
    this.connected = false;
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.ensureInitialData();
    }
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationGatewaySnapshot,
    forceReset: boolean,
    initialBind = false,
  ) {
    const connectionChanged = this.connected !== snapshot.connected;
    const clientChanged = this.client !== snapshot.client;
    this.syncGatewayState(snapshot);
    if (forceReset || (!initialBind && clientChanged)) {
      this.resetForClientChange();
    } else if (!initialBind && connectionChanged) {
      this.invalidateTransientRequests();
    }
    this.ensureInitialData();
  }

  private syncGatewayState(snapshot: ApplicationGatewaySnapshot) {
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    this.cron = {
      ...this.cron,
      client: snapshot.client,
      connected: snapshot.connected,
    };
  }

  private syncAgentState(agents = this.context.agents) {
    const agentState = agents.state;
    this.agentsLoading = agentState.agentsLoading;
    this.agentsError = agentState.agentsError;
    this.agentsList = agentState.agentsList ? selectableAgentsList(agentState.agentsList) : null;
    if (this.agentsList) {
      this.ensureSelectedAgentInList(this.agentsList);
    }
    this.syncCurrentAgentFiles(agents);
  }

  private ensureSelectedAgentInList(agentsList: AgentsListResult) {
    const selected = this.agentsSelectedId;
    if (!selected || !agentsList.agents.some((entry) => entry.id === selected)) {
      this.agentsSelectedId = agentsList.defaultId ?? agentsList.agents[0]?.id ?? null;
    }
  }

  private syncCurrentAgentFiles(agents = this.context.agents) {
    const agentId = this.resolveSelectedAgentId();
    if (!agentId || this.agentsPanel !== "files") {
      return;
    }
    const status = agents.files(agentId);
    if (!status.list) {
      return;
    }
    this.agentFilesList = status.list;
    this.agentFilesError = status.error;
    void this.selectDefaultAgentFile(agentId);
  }

  private async selectDefaultAgentFile(agentId: string) {
    const files = this.agentFilesList?.files ?? [];
    if (this.agentFileActive && files.some((file) => file.name === this.agentFileActive)) {
      return;
    }
    this.agentFileActive = files.find((file) => file.name === "AGENTS.md")?.name ?? null;
    if (this.agentFileActive) {
      await loadAgentFileContent(this, agentId, this.agentFileActive);
    }
  }

  private resetForClientChange() {
    this.agentsLoading = false;
    this.agentsError = null;
    this.agentsList = null;
    this.agentsSelectedId = null;
    this.resetSelectionState();
    this.cron = createInitialCronState({
      client: this.client,
      connected: this.connected,
    });
  }

  private resetForAgentsSourceChange() {
    this.agentsLoading = false;
    this.agentsError = null;
    this.agentsList = null;
    this.agentsSelectedId = null;
    this.resetSelectionState();
  }

  private invalidateTransientRequests() {
    this.requestGeneration += 1;
    this.agentsLoading = false;
    this.agentFilesLoading = false;
    this.agentFileSaving = false;
    this.agentIdentityLoading = false;
    this.agentSkillsLoading = false;
    this.toolsCatalogLoading = false;
    this.toolsCatalogLoadingAgentId = null;
    this.toolsEffectiveLoading = false;
    this.toolsEffectiveLoadingKey = null;
    this.cron = {
      ...this.cron,
      cronLoading: false,
      cronJobsLoadingMore: false,
      cronJobsReloadPending: false,
      cronJobsReloadPendingTableFilters: false,
      cronRunsLoadingMore: false,
      cronBusy: false,
    };
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    const gateway = this.context.gateway;
    if (data.gateway !== gateway || data.gatewaySnapshot !== gateway.snapshot) {
      return;
    }
    this.agentsLoading = false;
    this.agentsError = data.error;
    if (data.agentsList) {
      this.agentsList = data.agentsList;
      const nextSelectedId = data.selectedAgentId ?? this.resolveSelectedAgentId();
      if (nextSelectedId !== this.agentsSelectedId) {
        this.agentsSelectedId = nextSelectedId;
        // Route-driven agent switches (chip menu "Agent settings") must not
        // carry per-agent panel caches or identity drafts across agents.
        this.resetSelectionState();
      }
    }
  }

  private resolveSelectedAgentId() {
    return (
      this.agentsSelectedId ??
      this.agentsList?.defaultId ??
      this.agentsList?.agents?.[0]?.id ??
      null
    );
  }

  private chatAgentId() {
    return (
      parseAgentSessionKey(this.sessionKey)?.agentId ??
      this.context.gateway.snapshot.assistantAgentId ??
      this.agentsList?.defaultId ??
      "main"
    );
  }

  private agentIdentityById(): Record<string, AgentIdentityResult> {
    return Object.fromEntries(
      this.context.agentIdentity.entries().map((entry) => [entry.agentId, entry]),
    );
  }

  // Local /avatar/<id> images need a bearer credential when gateway auth is
  // active; the agent select uses this to decide whether <img> URLs can load.
  private controlUiAuthToken(): string | null {
    const { snapshot, connection } = this.context.gateway;
    return resolveControlUiAuthToken({
      hello: snapshot.hello,
      settings: connection,
      password: connection.password,
    });
  }

  private ensureInitialData() {
    if (!this.connected || !this.client || !this.routeDataInitialized) {
      return;
    }
    if (
      !this.context.runtimeConfig.state.configSnapshot &&
      !this.context.runtimeConfig.state.configLoading
    ) {
      void this.context.runtimeConfig.ensureLoaded();
    }
    if (!this.agentsList && !this.agentsLoading) {
      void this.loadAgentsAndCommit();
      return;
    }
    this.ensureAgentIdentities();
    this.loadActivePanelData();
  }

  private isCurrentRequest(
    client: GatewayBrowserClient,
    generation: number,
    agentId?: string,
    sources: AgentsRequestSources = {},
  ): boolean {
    return (
      this.client === client &&
      this.connected &&
      this.requestGeneration === generation &&
      (!sources.agents || this.context.agents === sources.agents) &&
      (!sources.agentIdentity || this.context.agentIdentity === sources.agentIdentity) &&
      (!sources.sessions || this.context.sessions === sources.sessions) &&
      (!agentId || this.resolveSelectedAgentId() === agentId)
    );
  }

  private ensureAgentIdentities() {
    const client = this.client;
    const agentIdentity = this.context.agentIdentity;
    const ids =
      this.agentsList?.agents.map((entry) => entry.id).filter((id) => !agentIdentity.get(id)) ?? [];
    if (!client || !this.connected || ids.length === 0 || this.agentIdentityLoading) {
      return;
    }
    const generation = this.requestGeneration;
    this.agentIdentityLoading = true;
    this.agentIdentityError = null;
    void agentIdentity
      .ensure(ids)
      .catch((err: unknown) => {
        if (this.isCurrentRequest(client, generation, undefined, { agentIdentity })) {
          this.agentIdentityError = String(err);
        }
      })
      .finally(() => {
        if (this.isCurrentRequest(client, generation, undefined, { agentIdentity })) {
          this.agentIdentityLoading = false;
        }
      });
  }

  private loadActivePanelData() {
    const agentId = this.resolveSelectedAgentId();
    if (!agentId) {
      return;
    }
    if (this.agentsPanel === "files" && this.agentFilesList?.agentId !== agentId) {
      void this.loadAgentFiles(agentId);
      return;
    }
    if (this.agentsPanel === "skills" && this.agentSkillsAgentId !== agentId) {
      void loadAgentSkills(this, agentId);
      return;
    }
    if (this.agentsPanel === "tools") {
      if (this.toolsCatalogResult?.agentId !== agentId && !this.toolsCatalogLoading) {
        void loadToolsCatalog(this, agentId);
      }
      this.loadEffectiveToolsForAgent(agentId);
      return;
    }
    if (this.agentsPanel === "channels" && !this.context.channels.state.channelsSnapshot) {
      void this.context.channels.refresh(false);
      return;
    }
    if (this.agentsPanel === "cron" && !this.cron.cronLoading && !this.cron.cronStatus) {
      void this.refreshCron();
    }
  }

  private async loadAgentsAndCommit() {
    const client = this.client;
    const generation = this.requestGeneration;
    const agents = this.context.agents;
    if (!client) {
      return;
    }
    await agents.ensureList();
    if (!this.isCurrentRequest(client, generation, undefined, { agents })) {
      return;
    }
    this.syncAgentState(agents);
    this.ensureAgentIdentities();
    this.loadActivePanelData();
  }

  private async loadAgentFiles(agentId: string, force = false) {
    const client = this.client;
    const agents = this.context.agents;
    if (!client || !this.connected || this.agentFilesLoading) {
      return;
    }
    const cached = agents.files(agentId);
    if (cached.list && !force) {
      this.syncCurrentAgentFiles(agents);
      return;
    }
    const generation = this.requestGeneration;
    this.agentFilesLoading = true;
    this.agentFilesError = null;
    try {
      const list = force ? await agents.refreshFiles(agentId) : await agents.ensureFiles(agentId);
      if (!this.isCurrentRequest(client, generation, agentId, { agents })) {
        return;
      }
      this.agentFilesList = list ?? agents.files(agentId).list;
      this.agentFilesError = agents.files(agentId).error;
    } finally {
      if (this.isCurrentRequest(client, generation, agentId, { agents })) {
        this.agentFilesLoading = false;
      }
    }
    if (this.isCurrentRequest(client, generation, agentId, { agents })) {
      await this.selectDefaultAgentFile(agentId);
    }
  }

  private async refreshCron() {
    const cronState = this.cron;
    if (!cronState.connected || !cronState.client) {
      return;
    }
    await Promise.all([
      loadCronStatus(cronState),
      loadCronJobsPage(cronState, { tableFilters: true }),
    ]);
    if (this.cron === cronState) {
      this.cron = { ...cronState, cronJobs: [...cronState.cronJobs] };
    }
  }

  private saveIdentityDraft() {
    const client = this.client;
    const agentId = this.resolveSelectedAgentId();
    if (!client || !agentId || this.identitySaving) {
      return;
    }
    const generation = this.requestGeneration;
    const agents = this.context.agents;
    const agentIdentity = this.context.agentIdentity;
    void saveIdentityDraft({
      host: this,
      client,
      agentId,
      agents,
      agentIdentity,
      isCurrent: () =>
        this.isCurrentRequest(client, generation, agentId, { agents, agentIdentity }),
      onSaved: () => this.syncAgentState(agents),
    });
  }

  private resetSelectionState() {
    this.requestGeneration += 1;
    this.agentFilesList = null;
    this.agentFilesError = null;
    this.agentFileActive = null;
    this.agentFileContents = {};
    this.agentFileDrafts = {};
    this.agentFilesLoading = false;
    this.agentFileSaving = false;
    this.agentSkillsReport = null;
    this.agentSkillsLoading = false;
    this.agentSkillsError = null;
    this.agentSkillsAgentId = null;
    this.agentIdentityLoading = false;
    this.agentIdentityError = null;
    resetIdentityDraft(this);
    this.toolsCatalogResult = null;
    this.toolsCatalogError = null;
    this.toolsCatalogLoading = false;
    this.toolsCatalogLoadingAgentId = null;
    resetToolsEffectiveState(this);
  }

  private findAgentIndex(agentId: string) {
    return findAgentConfigEntryIndex(
      currentConfigObject(this.context.runtimeConfig.state),
      agentId,
    );
  }

  private ensureAgentIndex(agentId: string) {
    return this.context.runtimeConfig.ensureAgentEntry(agentId);
  }

  private toolsPath(agentId: string, ensure: boolean) {
    const index = ensure ? this.ensureAgentIndex(agentId) : this.findAgentIndex(agentId);
    return index >= 0 ? (["agents", "list", index, "tools"] as Array<string | number>) : null;
  }

  private loadEffectiveToolsForAgent(agentId: string) {
    if (agentId !== this.chatAgentId()) {
      resetToolsEffectiveState(this);
      return;
    }
    const requestKey = buildToolsEffectiveRequestKey(this, {
      agentId,
      sessionKey: this.sessionKey,
    });
    if (this.toolsEffectiveResultKey === requestKey && !this.toolsEffectiveError) {
      return;
    }
    void loadToolsEffective(this, { agentId, sessionKey: this.sessionKey });
  }

  private selectAgent(agentId: string) {
    if (this.agentsSelectedId === agentId) {
      return;
    }
    this.agentsSelectedId = agentId;
    this.resetSelectionState();
    void this.context.agentIdentity.ensure([agentId]);
    this.loadActivePanelData();
  }

  private selectPanel(panel: AgentsPanel) {
    this.agentsPanel = panel;
    this.loadActivePanelData();
  }

  private refreshAgents() {
    const client = this.client;
    const generation = this.requestGeneration;
    const agents = this.context.agents;
    if (!client) {
      return;
    }
    void (async () => {
      await agents.refreshList();
      if (!this.isCurrentRequest(client, generation, undefined, { agents })) {
        return;
      }
      this.syncAgentState(agents);
      this.loadActivePanelData();
    })();
  }

  private saveAgentConfig() {
    const client = this.client;
    const generation = this.requestGeneration;
    const agents = this.context.agents;
    if (!client) {
      return;
    }
    const selectedBefore = this.agentsSelectedId;
    void (async () => {
      await this.context.runtimeConfig.save();
      await agents.refreshList();
      if (!this.isCurrentRequest(client, generation, undefined, { agents })) {
        return;
      }
      this.syncAgentState(agents);
      if (selectedBefore && this.agentsList?.agents.some((entry) => entry.id === selectedBefore)) {
        this.agentsSelectedId = selectedBefore;
      }
      this.ensureAgentIdentities();
      this.loadActivePanelData();
    })();
  }

  private saveSelectedAgentFile(agentId: string, name: string, content: string) {
    const client = this.client;
    const generation = this.requestGeneration;
    const agents = this.context.agents;
    if (!client) {
      return;
    }
    void saveAgentFile(this, agentId, name, content).then(() => {
      if (this.isCurrentRequest(client, generation, agentId, { agents })) {
        void this.loadAgentFiles(agentId, true);
      }
    });
  }

  private reloadConfig() {
    void this.context.runtimeConfig.refresh({ discardPendingChanges: true });
  }

  private runCronJobNow(jobId: string) {
    if (!this.cron.cronJobs.some((entry) => entry.id === jobId)) {
      return;
    }
    void runCronJob(this.cron, jobId, "force").finally(() => {
      this.cron = { ...this.cron, cronJobs: [...this.cron.cronJobs] };
    });
  }

  override render() {
    const configState = this.context.runtimeConfig.state;
    const selectedAgentId = this.resolveSelectedAgentId();
    const config = currentConfigObject(configState);
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("agents")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        renderAgents({
          basePath: this.context.basePath,
          authToken: this.controlUiAuthToken(),
          loading: this.agentsLoading,
          error: this.agentsError,
          agentsList: this.agentsList,
          selectedAgentId,
          activePanel: this.agentsPanel,
          config: {
            form: config,
            loading: configState.configLoading,
            saving: configState.configSaving,
            dirty: configState.configFormDirty,
          },
          channels: {
            snapshot: this.context.channels.state.channelsSnapshot,
            loading: this.context.channels.state.channelsLoading,
            error: this.context.channels.state.channelsError,
            lastSuccess: this.context.channels.state.channelsLastSuccess,
          },
          cron: {
            status: this.cron.cronStatus,
            jobs: this.cron.cronJobs,
            loading: this.cron.cronLoading,
            error: this.cron.cronError,
          },
          agentFiles: {
            list: this.agentFilesList,
            loading: this.agentFilesLoading,
            error: this.agentFilesError,
            active: this.agentFileActive,
            contents: this.agentFileContents,
            drafts: this.agentFileDrafts,
            saving: this.agentFileSaving,
          },
          agentIdentityLoading: this.agentIdentityLoading,
          agentIdentityError: this.agentIdentityError,
          agentIdentityById: this.agentIdentityById(),
          identityDraft: this.identityDraft,
          identitySaving: this.identitySaving,
          identityError: this.identityError,
          agentSkills: {
            report: this.agentSkillsReport,
            loading: this.agentSkillsLoading,
            error: this.agentSkillsError,
            agentId: this.agentSkillsAgentId,
            filter: this.skillsFilter,
          },
          toolsCatalog: {
            loading: this.toolsCatalogLoading,
            error: this.toolsCatalogError,
            result: this.toolsCatalogResult,
          },
          toolsEffective: {
            loading: this.toolsEffectiveLoading,
            error: this.toolsEffectiveError,
            result: this.toolsEffectiveResult,
          },
          runtimeSessionKey: this.sessionKey,
          runtimeSessionMatchesSelectedAgent: selectedAgentId === this.chatAgentId(),
          modelCatalog: this.chatModelCatalog,
          pinnedAgentIds: this.context.navigation.snapshot.pinnedAgentIds,
          onTogglePinnedAgent: (agentId) => togglePinnedAgent(this.context.navigation, agentId),
          onRefresh: () => this.refreshAgents(),
          onSelectAgent: (agentId) => this.selectAgent(agentId),
          onCreateAgent: () => this.context.navigate("custodian", { search: "?intent=new-agent" }),
          onSelectPanel: (panel) => this.selectPanel(panel),
          onLoadFiles: (agentId) => void this.loadAgentFiles(agentId, true),
          onSelectFile: (name) => {
            this.agentFileActive = name;
            if (selectedAgentId) {
              void loadAgentFileContent(this, selectedAgentId, name);
            }
          },
          onFileDraftChange: (name, content) => {
            this.agentFileDrafts = { ...this.agentFileDrafts, [name]: content };
          },
          onFileReset: (name) => {
            this.agentFileDrafts = {
              ...this.agentFileDrafts,
              [name]: this.agentFileContents[name] ?? "",
            };
          },
          onFileSave: (name) => {
            if (selectedAgentId) {
              this.saveSelectedAgentFile(
                selectedAgentId,
                name,
                this.agentFileDrafts[name] ?? this.agentFileContents[name] ?? "",
              );
            }
          },
          onToolsProfileChange: (agentId, profile, clearAllow) => {
            const path = this.toolsPath(agentId, Boolean(profile || clearAllow));
            if (!path) {
              return;
            }
            if (profile) {
              this.context.runtimeConfig.patchForm([...path, "profile"], profile);
            } else {
              this.context.runtimeConfig.removeFormValue([...path, "profile"]);
            }
            if (clearAllow) {
              this.context.runtimeConfig.removeFormValue([...path, "allow"]);
            }
          },
          onToolsOverridesChange: (agentId, alsoAllow, deny) => {
            const path = this.toolsPath(agentId, alsoAllow.length > 0 || deny.length > 0);
            if (!path) {
              return;
            }
            if (alsoAllow.length) {
              this.context.runtimeConfig.patchForm([...path, "alsoAllow"], alsoAllow);
            } else {
              this.context.runtimeConfig.removeFormValue([...path, "alsoAllow"]);
            }
            if (deny.length) {
              this.context.runtimeConfig.patchForm([...path, "deny"], deny);
            } else {
              this.context.runtimeConfig.removeFormValue([...path, "deny"]);
            }
          },
          onConfigReload: () => this.reloadConfig(),
          onConfigSave: () => this.saveAgentConfig(),
          onIdentityFieldChange: (field, value) => setIdentityDraftField(this, field, value),
          onIdentityAvatarSelect: (file) => selectIdentityAvatar(this, file),
          onIdentitySave: () => this.saveIdentityDraft(),
          onChannelsRefresh: () => void this.context.channels.refresh(false),
          onOpenMemoryImport: () => this.context.navigate("memory-import"),
          onCronRefresh: () => void this.refreshCron(),
          onCronRunNow: (jobId) => this.runCronJobNow(jobId),
          onSkillsFilterChange: (next) => (this.skillsFilter = next),
          onSkillsRefresh: () => {
            if (selectedAgentId) {
              void loadAgentSkills(this, selectedAgentId);
            }
          },
          onAgentSkillToggle: (agentId, skillName, enabled) => {
            const index = this.ensureAgentIndex(agentId);
            if (index < 0 || !skillName.trim()) {
              return;
            }
            const list = (
              currentConfigObject(configState) as {
                agents?: { list?: unknown[] };
              } | null
            )?.agents?.list;
            const entry = Array.isArray(list)
              ? (list[index] as { skills?: unknown } | undefined)
              : undefined;
            const base = Array.isArray(entry?.skills)
              ? normalizeStringEntries(entry.skills)
              : (this.agentSkillsReport?.skills?.map((skill) => skill.name).filter(Boolean) ?? []);
            const next = new Set(base);
            if (enabled) {
              next.add(skillName.trim());
            } else {
              next.delete(skillName.trim());
            }
            this.context.runtimeConfig.patchForm(["agents", "list", index, "skills"], [...next]);
          },
          onAgentSkillsClear: (agentId) => {
            const index = this.findAgentIndex(agentId);
            if (index >= 0) {
              this.context.runtimeConfig.removeFormValue(["agents", "list", index, "skills"]);
            }
          },
          onAgentSkillsDisableAll: (agentId) => {
            const index = this.ensureAgentIndex(agentId);
            if (index >= 0) {
              this.context.runtimeConfig.patchForm(["agents", "list", index, "skills"], []);
            }
          },
          onModelChange: (agentId, modelId) => {
            stageAgentPrimaryModel(this.context.runtimeConfig, agentId, modelId);
            void refreshVisibleToolsEffectiveForCurrentSession(this);
          },
          onModelFallbacksChange: (agentId, fallbacks) =>
            stageAgentModelFallbacks(this.context.runtimeConfig, agentId, fallbacks),
          onSetDefault: (agentId) => {
            void (async () => {
              await this.context.runtimeConfig.ensureLoaded();
              await setDefaultAgent(this.context.runtimeConfig, agentId, () =>
                this.context.agents.refreshList(),
              );
            })();
          },
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-agents-page")) {
  customElements.define("openclaw-agents-page", AgentsPage);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
