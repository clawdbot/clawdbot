import { consume } from "@lit/context";
import { html, LitElement } from "lit";
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
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import {
  resolveAgentConfig,
  resolveEffectiveModelFallbacks,
  resolveModelPrimary,
} from "../../lib/agents/display.ts";
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
import { loadAgentFileContent, saveAgentFile } from "./files.ts";
import { loadAgentSkills } from "./skills.ts";
import { renderAgents } from "./view.ts";

export type AgentsRouteData = {
  connected: boolean;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  error: string | null;
};

class AgentsPage extends LitElement implements AgentsState {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
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
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;
  @state() skillsFilter = "";
  @state() private cron = createInitialCronState();

  private routeDataInitialized = false;
  private stopGatewaySubscription?: () => void;
  private stopAgentsSubscription?: () => void;
  private stopAgentIdentitySubscription?: () => void;
  private stopChannelsSubscription?: () => void;
  private stopConfigSubscription?: () => void;
  private stopSessionsSubscription?: () => void;

  get sessions() {
    return this.context.sessions;
  }

  get sessionsResult() {
    return this.context.sessions.state.result;
  }

  get sessionKey() {
    return this.context.gateway.snapshot.sessionKey;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.syncGatewayState();
    this.syncAgentState();
    this.stopGatewaySubscription = this.context.gateway.subscribe((snapshot) => {
      const previousClient = this.client;
      this.syncGatewayState();
      if (previousClient !== snapshot.client) {
        this.resetForClientChange();
      }
      this.ensureInitialData();
    });
    this.stopAgentsSubscription = this.context.agents.subscribe(() => {
      this.syncAgentState();
      this.ensureAgentIdentities();
      this.loadActivePanelData();
      this.requestUpdate();
    });
    this.stopAgentIdentitySubscription = this.context.agentIdentity.subscribe(() =>
      this.requestUpdate(),
    );
    this.stopChannelsSubscription = this.context.channels.subscribe(() => this.requestUpdate());
    this.stopConfigSubscription = this.context.runtimeConfig.subscribe(() => this.requestUpdate());
    this.stopSessionsSubscription = this.context.sessions.subscribe(() => {
      void refreshVisibleToolsEffectiveForCurrentSession(this);
      this.requestUpdate();
    });
    this.ensureInitialData();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.ensureInitialData();
    }
  }

  override disconnectedCallback() {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopAgentsSubscription?.();
    this.stopAgentsSubscription = undefined;
    this.stopAgentIdentitySubscription?.();
    this.stopAgentIdentitySubscription = undefined;
    this.stopChannelsSubscription?.();
    this.stopChannelsSubscription = undefined;
    this.stopConfigSubscription?.();
    this.stopConfigSubscription = undefined;
    this.stopSessionsSubscription?.();
    this.stopSessionsSubscription = undefined;
    super.disconnectedCallback();
  }

  private syncGatewayState() {
    const gateway = this.context.gateway.snapshot;
    this.client = gateway.client;
    this.connected = gateway.connected;
    this.cron = {
      ...this.cron,
      client: gateway.client,
      connected: gateway.connected,
    };
  }

  private syncAgentState() {
    const agentState = this.context.agents.state;
    this.agentsLoading = agentState.agentsLoading;
    this.agentsError = agentState.agentsError;
    this.agentsList = agentState.agentsList;
    if (agentState.agentsList) {
      this.ensureSelectedAgentInList(agentState.agentsList);
    }
    this.syncCurrentAgentFiles();
  }

  private ensureSelectedAgentInList(agentsList: AgentsListResult) {
    const selected = this.agentsSelectedId;
    if (!selected || !agentsList.agents.some((entry) => entry.id === selected)) {
      this.agentsSelectedId = agentsList.defaultId ?? agentsList.agents[0]?.id ?? null;
    }
  }

  private syncCurrentAgentFiles() {
    const agentId = this.resolveSelectedAgentId();
    if (!agentId || this.agentsPanel !== "files") {
      return;
    }
    const status = this.context.agents.files(agentId);
    if (!status.list) {
      return;
    }
    this.agentFilesList = status.list;
    this.agentFilesError = status.error;
    if (
      this.agentFileActive &&
      !status.list.files.some((file) => file.name === this.agentFileActive)
    ) {
      this.agentFileActive = null;
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

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    this.agentsLoading = false;
    this.agentsError = data.error;
    if (data.agentsList) {
      this.agentsList = data.agentsList;
      this.agentsSelectedId = data.selectedAgentId ?? this.resolveSelectedAgentId();
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

  private ensureAgentIdentities() {
    const ids =
      this.agentsList?.agents
        .map((entry) => entry.id)
        .filter((id) => !this.context.agentIdentity.get(id)) ?? [];
    if (ids.length === 0 || this.agentIdentityLoading) {
      return;
    }
    this.agentIdentityLoading = true;
    this.agentIdentityError = null;
    void this.context.agentIdentity
      .ensure(ids)
      .catch((err: unknown) => {
        this.agentIdentityError = String(err);
      })
      .finally(() => {
        this.agentIdentityLoading = false;
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
    await this.context.agents.ensureList();
    this.syncAgentState();
    this.ensureAgentIdentities();
    this.loadActivePanelData();
  }

  private async loadAgentFiles(agentId: string, force = false) {
    if (!this.client || !this.connected || this.agentFilesLoading) {
      return;
    }
    const cached = this.context.agents.files(agentId);
    if (cached.list && !force) {
      this.syncCurrentAgentFiles();
      return;
    }
    this.agentFilesLoading = true;
    this.agentFilesError = null;
    try {
      const list = force
        ? await this.context.agents.refreshFiles(agentId)
        : await this.context.agents.ensureFiles(agentId);
      if (this.resolveSelectedAgentId() !== agentId) {
        return;
      }
      this.agentFilesList = list ?? this.context.agents.files(agentId).list;
      this.agentFilesError = this.context.agents.files(agentId).error;
      if (
        this.agentFileActive &&
        !this.agentFilesList?.files.some((file) => file.name === this.agentFileActive)
      ) {
        this.agentFileActive = null;
      }
    } finally {
      if (this.resolveSelectedAgentId() === agentId) {
        this.agentFilesLoading = false;
      }
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

  private resetSelectionState() {
    this.agentFilesList = null;
    this.agentFilesError = null;
    this.agentFileActive = null;
    this.agentFileContents = {};
    this.agentFileDrafts = {};
    this.agentFilesLoading = false;
    this.agentSkillsReport = null;
    this.agentSkillsError = null;
    this.agentSkillsAgentId = null;
    this.toolsCatalogResult = null;
    this.toolsCatalogError = null;
    this.toolsCatalogLoading = false;
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

  private modelEntry(index: number) {
    const list = (
      currentConfigObject(this.context.runtimeConfig.state) as {
        agents?: { list?: unknown[] };
      } | null
    )?.agents?.list;
    const existing = Array.isArray(list)
      ? (list[index] as { model?: unknown } | undefined)?.model
      : undefined;
    return { path: ["agents", "list", index, "model"] as Array<string | number>, existing };
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
    void (async () => {
      await this.context.agents.refreshList();
      this.syncAgentState();
      this.loadActivePanelData();
    })();
  }

  private saveAgentConfig() {
    const selectedBefore = this.agentsSelectedId;
    void (async () => {
      await this.context.runtimeConfig.save();
      await this.context.agents.refreshList();
      this.syncAgentState();
      if (selectedBefore && this.agentsList?.agents.some((entry) => entry.id === selectedBefore)) {
        this.agentsSelectedId = selectedBefore;
      }
      this.ensureAgentIdentities();
      this.loadActivePanelData();
    })();
  }

  private reloadConfig() {
    void this.context.runtimeConfig.refresh({ discardPendingChanges: true });
  }

  private runCronJobNow(jobId: string) {
    const job = this.cron.cronJobs.find((entry) => entry.id === jobId);
    if (!job) {
      return;
    }
    void runCronJob(this.cron, job, "force").finally(() => {
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
          <div class="page-sub">${subtitleForRoute("agents")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        this.context.basePath,
        renderAgents({
          basePath: this.context.basePath,
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
          onRefresh: () => this.refreshAgents(),
          onSelectAgent: (agentId) => this.selectAgent(agentId),
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
              void saveAgentFile(
                this,
                selectedAgentId,
                name,
                this.agentFileDrafts[name] ?? this.agentFileContents[name] ?? "",
              ).then(() => this.loadAgentFiles(selectedAgentId, true));
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
          onChannelsRefresh: () => void this.context.channels.refresh(false),
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
            const index = modelId ? this.ensureAgentIndex(agentId) : this.findAgentIndex(agentId);
            if (index < 0) {
              return;
            }
            const entry = this.modelEntry(index);
            if (!modelId) {
              this.context.runtimeConfig.removeFormValue(entry.path);
            } else if (entry.existing && typeof entry.existing === "object") {
              const fallbacks = (entry.existing as { fallbacks?: unknown }).fallbacks;
              this.context.runtimeConfig.patchForm(entry.path, {
                primary: modelId,
                ...(Array.isArray(fallbacks) ? { fallbacks } : {}),
              });
            } else {
              this.context.runtimeConfig.patchForm(entry.path, modelId);
            }
            void refreshVisibleToolsEffectiveForCurrentSession(this);
          },
          onModelFallbacksChange: (agentId, fallbacks) => {
            const normalized = normalizeStringEntries(fallbacks);
            const resolved = resolveAgentConfig(config, agentId);
            const primary =
              resolveModelPrimary(resolved.entry?.model) ??
              resolveModelPrimary(resolved.defaults?.model);
            const effective = resolveEffectiveModelFallbacks(
              resolved.entry?.model,
              resolved.defaults?.model,
            );
            const index =
              normalized.length > 0
                ? primary
                  ? this.ensureAgentIndex(agentId)
                  : -1
                : (effective?.length ?? 0) > 0 || this.findAgentIndex(agentId) >= 0
                  ? this.ensureAgentIndex(agentId)
                  : -1;
            if (index < 0) {
              return;
            }
            const entry = this.modelEntry(index);
            const currentPrimary =
              typeof entry.existing === "string"
                ? entry.existing.trim()
                : entry.existing &&
                    typeof entry.existing === "object" &&
                    typeof (entry.existing as { primary?: unknown }).primary === "string"
                  ? (entry.existing as { primary: string }).primary.trim()
                  : "";
            if (normalized.length === 0) {
              if (currentPrimary || primary) {
                this.context.runtimeConfig.patchForm(entry.path, currentPrimary || primary);
              } else {
                this.context.runtimeConfig.removeFormValue(entry.path);
              }
            } else if (currentPrimary || primary) {
              this.context.runtimeConfig.patchForm(entry.path, {
                primary: currentPrimary || primary,
                fallbacks: normalized,
              });
            }
          },
          onSetDefault: (agentId) => {
            void (async () => {
              await this.context.runtimeConfig.ensureLoaded();
              await setDefaultAgent(this.context.runtimeConfig, agentId, () =>
                this.context.agents.refreshList(),
              );
            })();
          },
        }),
        "agents",
        (routeId) => this.context.navigate(routeId),
        (routeId) => this.context.preload(routeId),
        { hostPolicy: this.context.hostPolicy },
      )}
    `;
  }
}

if (!customElements.get("openclaw-agents-page")) {
  customElements.define("openclaw-agents-page", AgentsPage);
}
