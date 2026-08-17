import { consume } from "@lit/context";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
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
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { selectableAgentsList } from "../../lib/agents/display.ts";
import {
  loadToolsCatalog,
  loadToolsEffective,
  buildToolsEffectiveRequestKey,
  refreshVisibleToolsEffectiveForCurrentSession,
  resetToolsEffectiveState,
  setDefaultAgent,
  type AgentsState,
} from "../../lib/agents/index.ts";
import { DEFAULT_AGENT_PANEL, type AgentsPanel } from "../../lib/agents/panels.ts";
import {
  loadChatMetadata,
  peekChatMetadata,
  revalidateChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import {
  createInitialCronState,
  loadCronJobsPage,
  loadCronScopeStats,
  loadCronStatus,
  runCronJob,
  type CronState,
} from "../../lib/cron/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  canCallGatewayMethod,
  type GatewayMethodOperatorScope,
} from "../../lib/gateway-methods.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { loadAgentFileContent, saveAgentFile } from "./files.ts";
import { GitHubIdentityController } from "./github-identity-controller.ts";
import {
  resetIdentityDraft,
  saveIdentityDraft,
  selectIdentityAvatar,
  setIdentityDraftField,
  togglePinnedAgent,
} from "./identity-actions.ts";
import { stageAgentModelFallbacks, stageAgentPrimaryModel } from "./model-config.ts";
import type { AgentIdentityDraft } from "./panels-overview.ts";
import {
  navigateToAgent,
  navigateToAgentPanel,
  syncAgentsCanonicalLocation,
} from "./route-navigation.ts";
import type { AgentsRouteData } from "./route.ts";
import { clearAgentSkillFilter, loadAgentSkills } from "./skills.ts";
import { renderAgents } from "./view.ts";

const AGENTS_DOCS_URL = "https://docs.openclaw.ai/concepts/multi-agent";

type AgentsRequestSources = Partial<
  Pick<ApplicationContext, "agents" | "agentIdentity" | "sessions">
>;

class AgentsPage
  extends OpenClawLightDomElement
  implements Omit<AgentsState, "agentsLoading" | "agentsError">
{
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: AgentsRouteData;

  @state() agentsList: AgentsListResult | null = null;
  @state() agentsSelectedId: string | null = null;
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
  @state() chatModelCatalogError: string | null = null;
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

  private routeDataInitialized = false;
  private hasBoundAgents = false;
  private agentsSource: ApplicationContext["agents"] | null = null;
  private hasBoundAgentIdentity = false;
  private agentIdentitySource: ApplicationContext["agentIdentity"] | null = null;
  private hasBoundSessions = false;
  private sessionsSource: ApplicationContext["sessions"] | null = null;
  private chatModelCatalogAgentId: string | null = null;
  private chatModelCatalogRequest: {
    client: GatewayBrowserClient;
    generation: number;
    agentId: string;
  } | null = null;
  private normalizedLocation = "";
  private readonly githubIdentity = new GitHubIdentityController({
    requestUpdate: () => this.requestUpdate(),
    runExternalMutation: (task, options) =>
      this.context.runtimeConfig.runExternalMutation(task, options),
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => this.resetForClientChange(),
    invalidateRequests: (change) => {
      if (change.identityChanged) {
        return;
      }
      this.invalidateTransientRequests();
      this.chatModelCatalog = [];
      this.chatModelCatalogAgentId = null;
      this.chatModelCatalogError = null;
    },
    onSnapshot: () => this.syncGatewayState(),
    ensureInitialData: () => this.ensureInitialData(),
  });
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
    );

  get sessions() {
    return this.context.sessions;
  }

  get client() {
    return this.gateway.client;
  }

  get connected() {
    return this.gateway.connected;
  }

  get requestGeneration() {
    return this.gateway.epoch;
  }

  get sessionsResult() {
    return this.context.sessions.state.result;
  }

  get sessionKey() {
    return this.context.gateway.snapshot.sessionKey;
  }

  get agentsPanel(): AgentsPanel {
    return this.routeData?.panel ?? DEFAULT_AGENT_PANEL;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.syncCanonicalLocation();
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.syncCanonicalLocation();
      this.ensureInitialData();
    }
  }

  private syncGatewayState() {
    if (this.cron.client !== this.client || this.cron.connected !== this.connected) {
      // In-flight cron loaders mutate their captured state; same-client
      // snapshots must retain it or loading never clears in the visible state.
      this.cron = { ...this.cron, client: this.client, connected: this.connected };
    }
  }

  private canCall(method: string, requiredScope: GatewayMethodOperatorScope): boolean {
    return canCallGatewayMethod(this.context?.gateway?.snapshot, method, requiredScope);
  }

  private syncAgentState(agents = this.context.agents) {
    const agentState = agents.state;
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
    if (!this.agentFileActive || !files.some((file) => file.name === this.agentFileActive)) {
      this.agentFileActive = files.find((file) => file.name === "AGENTS.md")?.name ?? null;
    }
    if (this.agentFileActive) {
      await loadAgentFileContent(this, agentId, this.agentFileActive);
    }
  }

  private resetForClientChange() {
    this.agentsList = null;
    this.agentsSelectedId = null;
    this.chatModelCatalog = [];
    this.chatModelCatalogAgentId = null;
    this.chatModelCatalogError = null;
    this.resetSelectionState();
  }

  private resetForAgentsSourceChange() {
    this.agentsList = null;
    this.agentsSelectedId = null;
    this.resetSelectionState();
  }

  private invalidateTransientRequests() {
    this.gateway.invalidate();
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
    if (!this.gateway.isRouteDataCurrent(data)) {
      return;
    }
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

  private syncCanonicalLocation() {
    this.normalizedLocation = syncAgentsCanonicalLocation(
      this.context,
      this.routeData,
      this.normalizedLocation,
    );
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
    if (!this.agentsList && !this.context.agents.state.agentsLoading) {
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
          this.agentIdentityError = formatUiError(err);
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
    if (this.agentsPanel === "overview") {
      this.ensureModelCatalog();
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
      this.syncGitHubIdentity(agentId);
      if (this.toolsCatalogResult?.agentId !== agentId && !this.toolsCatalogLoading) {
        void loadToolsCatalog(this, agentId);
      }
      this.loadEffectiveToolsForAgent(agentId);
      if (
        this.githubIdentity.supported &&
        !this.githubIdentity.status &&
        !this.githubIdentity.loading &&
        !this.githubIdentity.error
      ) {
        void this.githubIdentity.verify();
      }
      return;
    }
    if (this.agentsPanel === "channels" && !this.context.channels.state.channelsSnapshot) {
      void this.context.channels.refresh(false);
      return;
    }
    if (this.agentsPanel === "cron") {
      if (this.cron.cronAgentId !== agentId) {
        this.cron = createInitialCronState({
          client: this.client,
          connected: this.connected,
        });
        this.cron.cronAgentId = agentId;
      }
      if (!this.cron.cronLoading && !this.cron.cronStatus) {
        void this.refreshCron();
      }
    }
  }

  private syncGitHubIdentity(agentId: string | null) {
    this.githubIdentity.sync({
      client: this.client,
      connected: this.connected,
      agentId,
      config: currentConfigObject(this.context.runtimeConfig.state),
      supported: this.canCall("tools.github.status", "operator.read"),
      configurable: this.canCall("tools.github.configure", "operator.admin"),
      clientRevision: this.requestGeneration,
    });
  }

  private ensureModelCatalog(options: { refresh?: boolean } = {}) {
    const client = this.client;
    const agentId = this.resolveSelectedAgentId();
    if (!client || !this.connected || !agentId) {
      return;
    }
    if (!options.refresh) {
      const cached = peekChatMetadata(client, agentId);
      if (cached) {
        this.chatModelCatalog = cached.models ?? [];
        this.chatModelCatalogAgentId = agentId;
        this.chatModelCatalogError = null;
        return;
      }
    }
    const generation = this.requestGeneration;
    const previousRequest = this.chatModelCatalogRequest;
    if (
      previousRequest?.client === client &&
      previousRequest.generation === generation &&
      previousRequest.agentId === agentId
    ) {
      return;
    }
    if (this.chatModelCatalogAgentId !== agentId) {
      this.chatModelCatalog = [];
    }
    const request = { client, generation, agentId };
    this.chatModelCatalogRequest = request;
    this.chatModelCatalogError = null;
    // Chat metadata carries the selected agent's already-prepared startup models
    // without initiating the live discovery reserved for explicit picker use.
    const metadataRequest = options.refresh
      ? revalidateChatMetadata(client, agentId)
      : loadChatMetadata(client, agentId);
    void metadataRequest
      .then((result) => {
        if (this.isCurrentRequest(client, generation, agentId)) {
          const models = result.models ?? [];
          this.chatModelCatalog = models;
          this.chatModelCatalogAgentId = agentId;
          this.chatModelCatalogError = null;
        }
      })
      .catch((error: unknown) => {
        if (this.isCurrentRequest(client, generation, agentId)) {
          this.chatModelCatalogAgentId = null;
          this.chatModelCatalogError = formatUiError(error);
        }
      })
      .finally(() => {
        if (this.chatModelCatalogRequest === request) {
          this.chatModelCatalogRequest = null;
        }
      });
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
    if (!cronState.connected || !cronState.client || cronState.cronLoading) {
      return;
    }
    await Promise.all([
      this.runCronTask((current) => loadCronStatus(current)),
      this.runCronTask((current) => loadCronScopeStats(current)),
      this.runCronTask((current) => loadCronJobsPage(current, { tableFilters: true })),
    ]);
  }

  private async runCronTask<T>(task: (cronState: CronState) => Promise<T>): Promise<T> {
    const cronState = this.cron;
    try {
      const result = task(cronState);
      if (this.cron === cronState) {
        this.requestUpdate();
      }
      return await result;
    } finally {
      if (this.cron === cronState) {
        this.requestUpdate();
      }
    }
  }

  private saveIdentityDraft() {
    if (!this.canCall("agents.update", "operator.admin")) {
      return;
    }
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
      expectedClient: client,
      agentId,
      agents,
      agentIdentity,
      runtimeConfig: this.context.runtimeConfig,
      canDispatch: () => this.canCall("agents.update", "operator.admin"),
      isCurrent: () =>
        this.isCurrentRequest(client, generation, agentId, { agents, agentIdentity }),
      onSaved: () => this.syncAgentState(agents),
    });
  }

  private resetSelectionState() {
    this.gateway.invalidate();
    this.chatModelCatalog = [];
    this.chatModelCatalogAgentId = null;
    this.chatModelCatalogError = null;
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
    this.cron = createInitialCronState({
      client: this.client,
      connected: this.connected,
    });
  }

  private toolsPath(agentId: string, ensure: boolean) {
    const target = this.context.runtimeConfig.agentEntry(agentId, { ensure });
    return target ? ([...target.path, "tools"] as Array<string | number>) : null;
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
    if (!this.canCall("config.set", "operator.admin")) {
      return;
    }
    const client = this.client;
    const generation = this.requestGeneration;
    const agents = this.context.agents;
    if (!client) {
      return;
    }
    const selectedBefore = this.agentsSelectedId;
    void (async () => {
      if (!(await this.context.runtimeConfig.save())) {
        return;
      }
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

  private setDefaultAgent(agentId: string) {
    if (!this.canCall("config.set", "operator.admin")) {
      return;
    }
    const client = this.client;
    const generation = this.requestGeneration;
    const agents = this.context.agents;
    const runtimeConfig = this.context.runtimeConfig;
    if (!client) {
      return;
    }
    const canDispatch = () =>
      this.context.runtimeConfig === runtimeConfig &&
      this.isCurrentRequest(client, generation, undefined, { agents }) &&
      this.canCall("config.set", "operator.admin");
    void (async () => {
      await runtimeConfig.ensureLoaded();
      if (!canDispatch()) {
        return;
      }
      await setDefaultAgent(runtimeConfig, agentId, () => agents.refreshList(), canDispatch);
    })();
  }

  private saveSelectedAgentFile(agentId: string, name: string, content: string) {
    if (!this.canCall("agents.files.set", "operator.admin")) {
      return;
    }
    const client = this.client;
    const generation = this.requestGeneration;
    const agents = this.context.agents;
    if (!client) {
      return;
    }
    void saveAgentFile(this, agentId, name, content).then((saved) => {
      if (saved && this.isCurrentRequest(client, generation, agentId, { agents })) {
        void this.loadAgentFiles(agentId, true);
      }
    });
  }

  private reloadConfig() {
    void this.context.runtimeConfig.refresh({ discardPendingChanges: true });
  }

  private clearAgentSkills(agentId: string) {
    if (!this.canCall("config.patch", "operator.admin")) {
      return;
    }
    const client = this.client;
    const generation = this.requestGeneration;
    const agents = this.context.agents;
    const runtimeConfig = this.context.runtimeConfig;
    if (!client) {
      return;
    }
    const canDispatch = () =>
      this.context.runtimeConfig === runtimeConfig &&
      this.isCurrentRequest(client, generation, agentId, { agents }) &&
      this.canCall("config.patch", "operator.admin");
    void clearAgentSkillFilter(runtimeConfig, agentId, canDispatch).then((updated) => {
      if (!canDispatch()) {
        return;
      }
      if (!updated) {
        this.agentSkillsError =
          runtimeConfig.state.lastError ?? t("agents.skillsPanel.updateError");
        return;
      }
      this.agentSkillsError = null;
      void loadAgentSkills(this, agentId);
    });
  }

  private runCronJobNow(jobId: string) {
    if (!this.canCall("cron.run", "operator.admin")) {
      return;
    }
    if (!this.cron.cronJobs.some((entry) => entry.id === jobId)) {
      return;
    }
    void this.runCronTask((cronState) => runCronJob(cronState, jobId, "force"));
  }

  override render() {
    const configState = this.context.runtimeConfig.state;
    const agentsState = this.context.agents.state;
    const selectedAgentId = this.resolveSelectedAgentId();
    const config = currentConfigObject(configState);
    const access = {
      canCreateAgent: this.canCall("openclaw.chat", "operator.admin"),
      canPatchConfig: this.canCall("config.patch", "operator.admin"),
      canUpdateConfig: this.canCall("config.set", "operator.admin"),
      canUpdateIdentity: this.canCall("agents.update", "operator.admin"),
      canWriteFiles: this.canCall("agents.files.set", "operator.admin"),
      canRunCron: this.canCall("cron.run", "operator.admin"),
    };
    this.syncGitHubIdentity(selectedAgentId);
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("agents")}</div>
          <div class="page-subtitle">
            ${subtitleForRoute("agents")} ${renderDocsLink(AGENTS_DOCS_URL, t("common.learnMore"))}
          </div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        renderAgents({
          access,
          basePath: this.context.basePath,
          authToken: this.controlUiAuthToken(),
          loading: agentsState.agentsLoading,
          error: agentsState.agentsError,
          agentsList: this.agentsList,
          selectedAgentId,
          activePanel: this.agentsPanel,
          config: {
            form: config,
            loading: configState.configLoading,
            saving: configState.configSaving,
            dirty: configState.configFormDirty,
            error:
              configState.configAutoSaveStatus === "error" ||
              configState.configAutoSaveStatus === "conflict"
                ? configState.lastError
                : null,
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
            jobsTotal: this.cron.cronJobsTotal,
            jobsHasMore: this.cron.cronJobsHasMore,
            jobsLoadingMore: this.cron.cronJobsLoadingMore,
            scopedTotal: this.cron.cronScopedTotal,
            scopedNextWakeAtMs: this.cron.cronScopedNextWakeAtMs,
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
          githubIdentity: this.githubIdentity,
          runtimeSessionKey: this.sessionKey,
          runtimeSessionMatchesSelectedAgent: selectedAgentId === this.chatAgentId(),
          modelCatalog: this.chatModelCatalog,
          modelCatalogError: this.chatModelCatalogError,
          pinnedAgentIds: this.context.navigation.snapshot.pinnedAgentIds,
          onTogglePinnedAgent: (agentId) => togglePinnedAgent(this.context.navigation, agentId),
          onRefresh: () => this.refreshAgents(),
          onSelectAgent: (agentId) =>
            navigateToAgent(this.context, agentId, selectedAgentId, this.agentsPanel),
          onCreateAgent: () => {
            if (this.canCall("openclaw.chat", "operator.admin")) {
              this.context.navigate("custodian", { search: "?intent=new-agent" });
            }
          },
          onSelectPanel: (panel) =>
            navigateToAgentPanel(this.context, selectedAgentId, this.agentsPanel, panel),
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
            if (!this.canCall("config.set", "operator.admin")) {
              return;
            }
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
            if (!this.canCall("config.set", "operator.admin")) {
              return;
            }
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
          onIdentityFieldChange: (field, value) => {
            if (this.canCall("agents.update", "operator.admin")) {
              setIdentityDraftField(this, field, value);
            }
          },
          onIdentityAvatarSelect: (file) => {
            if (this.canCall("agents.update", "operator.admin")) {
              selectIdentityAvatar(this, file);
            }
          },
          onIdentitySave: () => this.saveIdentityDraft(),
          onChannelsRefresh: () => void this.context.channels.refresh(false),
          onOpenMemoryImport: () => this.context.navigate("memory-import"),
          onOpenMemorySettings: () => this.context.navigate("memory"),
          onOpenAgentDefaults: () => this.context.navigate("ai-agents"),
          onCronRefresh: () => void this.refreshCron(),
          onCronLoadMore: () =>
            void this.runCronTask((cronState) =>
              loadCronJobsPage(cronState, { append: true, tableFilters: true }),
            ),
          onCronRunNow: (jobId) => this.runCronJobNow(jobId),
          onSkillsFilterChange: (next) => (this.skillsFilter = next),
          onSkillsRefresh: () => {
            if (selectedAgentId) {
              void loadAgentSkills(this, selectedAgentId);
            }
          },
          onAgentSkillToggle: (agentId, skillName, enabled) => {
            if (!this.canCall("config.set", "operator.admin")) {
              return;
            }
            const target = this.context.runtimeConfig.agentEntry(agentId, { ensure: true });
            if (!target || !skillName.trim()) {
              return;
            }
            const base = Array.isArray(target.entry.skills)
              ? normalizeStringEntries(target.entry.skills)
              : (this.agentSkillsReport?.skills?.map((skill) => skill.name).filter(Boolean) ?? []);
            const next = new Set(base);
            if (enabled) {
              next.add(skillName.trim());
            } else {
              next.delete(skillName.trim());
            }
            this.context.runtimeConfig.patchForm([...target.path, "skills"], [...next]);
          },
          onAgentSkillsClear: (agentId) => this.clearAgentSkills(agentId),
          onAgentSkillsDisableAll: (agentId) => {
            if (!this.canCall("config.set", "operator.admin")) {
              return;
            }
            const target = this.context.runtimeConfig.agentEntry(agentId, { ensure: true });
            if (target) {
              this.context.runtimeConfig.patchForm([...target.path, "skills"], []);
            }
          },
          onModelChange: (agentId, modelId) => {
            if (!this.canCall("config.set", "operator.admin")) {
              return;
            }
            stageAgentPrimaryModel(this.context.runtimeConfig, agentId, modelId);
            void refreshVisibleToolsEffectiveForCurrentSession(this);
          },
          // Availability facts (provider keys added/removed, new models) go
          // stale in the per-agent cache; opening the picker re-reads them,
          // mirroring the chat composer's on-open refresh.
          onModelCatalogRetry: () => this.ensureModelCatalog({ refresh: true }),
          onModelFallbacksChange: (agentId, fallbacks) => {
            if (this.canCall("config.set", "operator.admin")) {
              stageAgentModelFallbacks(this.context.runtimeConfig, agentId, fallbacks);
            }
          },
          onSetDefault: (agentId) => this.setDefaultAgent(agentId),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-agents-page")) {
  customElements.define("openclaw-agents-page", AgentsPage);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
