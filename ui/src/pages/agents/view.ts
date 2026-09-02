// Control UI view renders agents screen content.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import "../../components/agent-select-registration.ts";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
  ModelCatalogEntry,
  SkillStatusReport,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import { handleCopyButton } from "../../components/copy-button.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import {
  renderSettingsEmpty,
  renderSettingsNavRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import type { GitHubIdentityController } from "../../features/github-connections/github-identity-controller.ts";
import { t } from "../../i18n/index.ts";
import {
  agentBadgeText,
  buildAgentContext,
  normalizeAgentLabel,
} from "../../lib/agents/display.ts";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import "./memory/memory-panel.ts";
import type { AgentsPanel } from "../../lib/agents/index.ts";
import type { AgentIdentityDraft } from "./panels-overview.ts";
import { renderAgentOverview } from "./panels-overview.ts";
import { renderAgentFiles, renderAgentChannels, renderAgentCron } from "./panels-status-files.ts";
import { renderAgentTools, renderAgentSkills } from "./panels-tools-skills.ts";

type ConfigState = {
  form: Record<string, unknown> | null;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
};

type ChannelsState = {
  snapshot: ChannelsStatusSnapshot | null;
  loading: boolean;
  error: string | null;
  lastSuccess: number | null;
};

type CronState = {
  status: CronStatus | null;
  jobs: CronJob[];
  jobsTotal: number;
  jobsHasMore: boolean;
  jobsLoadingMore: boolean;
  scopedTotal: number | null;
  scopedNextWakeAtMs: number | null;
  loading: boolean;
  error: string | null;
};

type AgentFilesState = {
  list: AgentsFilesListResult | null;
  loading: boolean;
  error: string | null;
  active: string | null;
  contents: Record<string, string>;
  drafts: Record<string, string>;
  saving: boolean;
};

type AgentSkillsState = {
  report: SkillStatusReport | null;
  loading: boolean;
  error: string | null;
  agentId: string | null;
  filter: string;
};

type ToolsCatalogState = {
  loading: boolean;
  error: string | null;
  result: ToolsCatalogResult | null;
};

type ToolsEffectiveState = {
  loading: boolean;
  error: string | null;
  result: ToolsEffectiveResult | null;
};

type AgentsProps = {
  access: {
    canCreateAgent: boolean;
    canPatchConfig: boolean;
    canUpdateConfig: boolean;
    canUpdateIdentity: boolean;
    canWriteFiles: boolean;
    canRunCron: boolean;
  };
  basePath: string;
  authToken: string | null;
  loading: boolean;
  error: string | null;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  activePanel: AgentsPanel;
  config: ConfigState;
  channels: ChannelsState;
  cron: CronState;
  agentFiles: AgentFilesState;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
  identityDraft: AgentIdentityDraft;
  identitySaving: boolean;
  identityError: string | null;
  agentSkills: AgentSkillsState;
  toolsCatalog: ToolsCatalogState;
  toolsEffective: ToolsEffectiveState;
  githubIdentity: GitHubIdentityController;
  onOpenGitHubConnections: () => void;
  runtimeSessionKey: string;
  runtimeSessionMatchesSelectedAgent: boolean;
  modelCatalog: ModelCatalogEntry[];
  modelCatalogError: string | null;
  pinnedAgentIds: readonly string[];
  onTogglePinnedAgent: (agentId: string) => void;
  onRefresh: () => void;
  onSelectAgent: (agentId: string) => void;
  onCreateAgent: () => void;
  onSelectPanel: (panel: AgentsPanel) => void;
  onLoadFiles: (agentId: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
  onToolsProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) => void;
  onToolsOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
  onIdentityFieldChange: (field: "name" | "emoji", value: string) => void;
  onIdentityAvatarSelect: (file: File) => void;
  onIdentitySave: () => void;
  onModelChange: (agentId: string, modelId: string | null) => void;
  onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
  onModelCatalogRetry: () => void;
  onChannelsRefresh: () => void;
  onOpenMemoryImport?: () => void;
  onOpenMemorySettings?: () => void;
  onOpenAgentDefaults: () => void;
  onCronRefresh: () => void;
  onCronLoadMore: () => void;
  onCronRunNow: (jobId: string) => void;
  onSkillsFilterChange: (next: string) => void;
  onSkillsRefresh: () => void;
  onAgentSkillToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onAgentSkillsClear: (agentId: string) => void;
  onAgentSkillsDisableAll: (agentId: string) => void;
  onSetDefault: (agentId: string) => void;
};

type AgentRosterRow = AgentsListResult["agents"][number];

function buildAgentRosterTree(agents: AgentRosterRow[]) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenById = new Map<string, AgentRosterRow[]>();
  const roots: AgentRosterRow[] = [];

  for (const agent of agents) {
    const creatorAgentId = agent.creatorAgentId;
    if (creatorAgentId && creatorAgentId !== agent.id && agentById.has(creatorAgentId)) {
      const children = childrenById.get(creatorAgentId) ?? [];
      children.push(agent);
      childrenById.set(creatorAgentId, children);
    } else {
      roots.push(agent);
    }
  }

  const entries: Array<{ agent: AgentRosterRow; creatorAgentId?: string }> = [];
  const visited = new Set<string>();
  const append = (agent: AgentRosterRow, depth: number): void => {
    if (visited.has(agent.id)) {
      return;
    }
    visited.add(agent.id);
    entries.push({
      agent,
      ...(depth > 0 && agent.creatorAgentId ? { creatorAgentId: agent.creatorAgentId } : {}),
    });
    for (const child of childrenById.get(agent.id) ?? []) {
      append(child, depth + 1);
    }
  };
  roots.forEach((agent) => append(agent, 0));
  // Match the CLI tree: malformed cycles cannot make configured agents disappear.
  agents.forEach((agent) => append(agent, 0));
  return entries;
}

export function renderAgents(props: AgentsProps) {
  const agents = props.agentsList?.agents ?? [];
  const defaultId = props.agentsList?.defaultId ?? null;
  const selectedId = props.selectedAgentId ?? defaultId ?? agents[0]?.id ?? null;
  const selectedAgent = selectedId
    ? (agents.find((agent) => agent.id === selectedId) ?? null)
    : null;
  const agentOptions = buildAgentRosterTree(agents).map(({ agent, creatorAgentId }) => ({
    value: agent.id,
    label: normalizeAgentLabel(agent),
    agent,
    description: creatorAgentId ? t("agents.createdBy", { id: creatorAgentId }) : undefined,
    badge: agentBadgeText(agent.id, defaultId) ?? undefined,
  }));
  const selectedSkillCount =
    selectedId && props.agentSkills.agentId === selectedId
      ? (props.agentSkills.report?.skills?.length ?? null)
      : null;

  const channelEntryCount = props.channels.snapshot
    ? Object.keys(props.channels.snapshot.channelAccounts ?? {}).length
    : null;
  const cronJobCount = selectedId ? props.cron.jobsTotal : null;
  const tabCounts: Record<string, number | null> = {
    files: props.agentFiles.list?.files?.length ?? null,
    skills: selectedSkillCount,
    channels: channelEntryCount,
    cron: cronJobCount || null,
  };

  return html`
    <div class="agents-layout">
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          ${agentOptions.length > 1
            ? html`
                <div class="agents-control-select">
                  <openclaw-agent-select
                    .options=${agentOptions}
                    .value=${selectedId ?? ""}
                    .accessibleLabel=${t("usage.filters.agent")}
                    .identityById=${props.agentIdentityById}
                    .authToken=${props.authToken}
                    .disabled=${props.loading}
                    .onSelect=${props.onSelectAgent}
                    .onCreateAgent=${props.access.canCreateAgent ? props.onCreateAgent : null}
                  ></openclaw-agent-select>
                </div>
              `
            : nothing}
          <div class="agents-toolbar-actions">
            ${agentOptions.length <= 1 && props.access.canCreateAgent
              ? html`
                  <button
                    class="btn btn--sm btn--ghost agents-create-btn"
                    ?disabled=${props.loading}
                    @click=${props.onCreateAgent}
                  >
                    ${t("custodian.newAgent")}
                  </button>
                `
              : nothing}
            ${selectedAgent
              ? html`
                  ${keyed(
                    selectedAgent.id,
                    html`
                      <button
                        type="button"
                        class="btn btn--sm btn--ghost"
                        @click=${(event: Event) =>
                          void handleCopyButton(event, selectedAgent.id, t("agents.copyId"))}
                      >
                        <span data-copy-label>${t("agents.copyId")}</span>
                      </button>
                    `,
                  )}
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    ?disabled=${!props.access.canUpdateConfig ||
                    Boolean(defaultId && selectedAgent.id === defaultId)}
                    @click=${() => props.onSetDefault(selectedAgent.id)}
                  >
                    ${defaultId && selectedAgent.id === defaultId
                      ? t("agents.default")
                      : t("agents.setDefault")}
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    @click=${() => props.onTogglePinnedAgent(selectedAgent.id)}
                  >
                    ${props.pinnedAgentIds.includes(selectedAgent.id)
                      ? t("agents.unpinFromSwitcher")
                      : t("agents.pinToSwitcher")}
                  </button>
                `
              : nothing}
            <button
              class="btn btn--sm agents-refresh-btn"
              ?disabled=${props.loading}
              @click=${props.onRefresh}
            >
              ${props.loading ? t("common.loading") : t("common.refresh")}
            </button>
          </div>
        </div>
        ${props.error
          ? html`<div class="callout danger" style="margin-top: 8px;">${props.error}</div>`
          : nothing}
      </section>
      <section class="agents-main">
        <div class="settings-group">
          ${renderSettingsNavRow({
            title: t("agents.defaults.title"),
            description: t("agents.defaults.description"),
            onClick: props.onOpenAgentDefaults,
          })}
        </div>
        ${!selectedAgent
          ? renderSettingsSection(
              { title: t("agents.selectTitle") },
              renderSettingsEmpty(t("agents.selectSubtitle")),
            )
          : html`
              ${renderAgentTabs(
                props.activePanel,
                (panel) => props.onSelectPanel(panel),
                tabCounts,
              )}
              <div
                id="agent-panel"
                class="settings-stack"
                role="tabpanel"
                aria-labelledby=${`agents-tab-${props.activePanel}`}
              >
                ${props.config.error
                  ? html`<div class="callout danger" role="alert">${props.config.error}</div>`
                  : nothing}
                ${props.activePanel === "overview"
                  ? keyed(
                      selectedAgent.id,
                      renderAgentOverview({
                        agent: selectedAgent,
                        basePath: props.basePath,
                        defaultId,
                        configForm: props.config.form,
                        agentFilesList: props.agentFiles.list,
                        agentIdentity: props.agentIdentityById[selectedAgent.id] ?? null,
                        agentIdentityError: props.agentIdentityError,
                        agentIdentityLoading: props.agentIdentityLoading,
                        identityDraft: props.identityDraft,
                        identitySaving: props.identitySaving,
                        identityError: props.identityError,
                        canUpdateConfig: props.access.canUpdateConfig,
                        canUpdateIdentity: props.access.canUpdateIdentity,
                        configLoading: props.config.loading,
                        configSaving: props.config.saving,
                        configDirty: props.config.dirty,
                        modelCatalog: props.modelCatalog,
                        modelCatalogError: props.modelCatalogError,
                        onConfigReload: props.onConfigReload,
                        onConfigSave: props.onConfigSave,
                        onIdentityFieldChange: props.onIdentityFieldChange,
                        onIdentityAvatarSelect: props.onIdentityAvatarSelect,
                        onIdentitySave: props.onIdentitySave,
                        onModelChange: props.onModelChange,
                        onModelFallbacksChange: props.onModelFallbacksChange,
                        onModelCatalogRetry: props.onModelCatalogRetry,
                        onSelectPanel: props.onSelectPanel,
                      }),
                    )
                  : nothing}
                ${props.activePanel === "files"
                  ? renderAgentFiles({
                      agentId: selectedAgent.id,
                      agentFilesList: props.agentFiles.list,
                      agentFilesLoading: props.agentFiles.loading,
                      agentFilesError: props.agentFiles.error,
                      agentFileActive: props.agentFiles.active,
                      agentFileContents: props.agentFiles.contents,
                      agentFileDrafts: props.agentFiles.drafts,
                      agentFileSaving: props.agentFiles.saving,
                      canWrite: props.access.canWriteFiles,
                      onLoadFiles: props.onLoadFiles,
                      onSelectFile: props.onSelectFile,
                      onFileDraftChange: props.onFileDraftChange,
                      onFileReset: props.onFileReset,
                      onFileSave: props.onFileSave,
                    })
                  : nothing}
                ${props.activePanel === "tools"
                  ? renderAgentTools({
                      agentId: selectedAgent.id,
                      configForm: props.config.form,
                      configLoading: props.config.loading,
                      configSaving: props.config.saving,
                      configDirty: props.config.dirty,
                      toolsCatalogLoading: props.toolsCatalog.loading,
                      toolsCatalogError: props.toolsCatalog.error,
                      toolsCatalogResult: props.toolsCatalog.result,
                      toolsEffectiveLoading: props.toolsEffective.loading,
                      toolsEffectiveError: props.toolsEffective.error,
                      toolsEffectiveResult: props.toolsEffective.result,
                      runtimeSessionKey: props.runtimeSessionKey,
                      runtimeSessionMatchesSelectedAgent: props.runtimeSessionMatchesSelectedAgent,
                      canUpdateConfig: props.access.canUpdateConfig,
                      githubIdentity: props.githubIdentity,
                      onOpenGitHubConnections: props.onOpenGitHubConnections,
                      onProfileChange: props.onToolsProfileChange,
                      onOverridesChange: props.onToolsOverridesChange,
                      onConfigReload: props.onConfigReload,
                      onConfigSave: props.onConfigSave,
                    })
                  : nothing}
                ${props.activePanel === "skills"
                  ? renderAgentSkills({
                      agentId: selectedAgent.id,
                      report: props.agentSkills.report,
                      loading: props.agentSkills.loading,
                      error: props.agentSkills.error,
                      activeAgentId: props.agentSkills.agentId,
                      configForm: props.config.form,
                      configLoading: props.config.loading,
                      configSaving: props.config.saving,
                      configDirty: props.config.dirty,
                      filter: props.agentSkills.filter,
                      canPatchConfig: props.access.canPatchConfig,
                      canUpdateConfig: props.access.canUpdateConfig,
                      onFilterChange: props.onSkillsFilterChange,
                      onRefresh: props.onSkillsRefresh,
                      onToggle: props.onAgentSkillToggle,
                      onClear: props.onAgentSkillsClear,
                      onDisableAll: props.onAgentSkillsDisableAll,
                      onConfigReload: props.onConfigReload,
                      onConfigSave: props.onConfigSave,
                    })
                  : nothing}
                ${props.activePanel === "channels"
                  ? renderAgentChannels({
                      context: buildAgentContext(
                        selectedAgent,
                        props.config.form,
                        props.agentFiles.list,
                        defaultId,
                        props.agentIdentityById[selectedAgent.id] ?? null,
                      ),
                      configForm: props.config.form,
                      snapshot: props.channels.snapshot,
                      loading: props.channels.loading,
                      error: props.channels.error,
                      lastSuccess: props.channels.lastSuccess,
                      onRefresh: props.onChannelsRefresh,
                      onSelectPanel: props.onSelectPanel,
                    })
                  : nothing}
                ${props.activePanel === "cron"
                  ? renderAgentCron({
                      context: buildAgentContext(
                        selectedAgent,
                        props.config.form,
                        props.agentFiles.list,
                        defaultId,
                        props.agentIdentityById[selectedAgent.id] ?? null,
                      ),
                      agentId: selectedAgent.id,
                      jobs: props.cron.jobs,
                      jobsTotal: props.cron.jobsTotal,
                      jobsHasMore: props.cron.jobsHasMore,
                      jobsLoadingMore: props.cron.jobsLoadingMore,
                      status: props.cron.status,
                      scopedTotal: props.cron.scopedTotal,
                      scopedNextWakeAtMs: props.cron.scopedNextWakeAtMs,
                      loading: props.cron.loading,
                      error: props.cron.error,
                      canRunNow: props.access.canRunCron,
                      onRefresh: props.onCronRefresh,
                      onLoadMore: props.onCronLoadMore,
                      onRunNow: props.onCronRunNow,
                      onSelectPanel: props.onSelectPanel,
                    })
                  : nothing}
                ${props.activePanel === "memory"
                  ? html`
                      <div class="settings-group agent-memory-import-row">
                        ${renderSettingsNavRow({
                          title: t("tabs.memory"),
                          description: t("subtitles.memory"),
                          onClick: () => props.onOpenMemorySettings?.(),
                        })}
                        ${renderSettingsNavRow({
                          title: t("tabs.memoryImport"),
                          description: t("subtitles.memoryImport"),
                          onClick: () => props.onOpenMemoryImport?.(),
                        })}
                      </div>
                      <openclaw-agent-memory-panel
                        .agentId=${selectedAgent.id}
                      ></openclaw-agent-memory-panel>
                    `
                  : nothing}
              </div>
            `}
      </section>
    </div>
  `;
}

function renderAgentTabs(
  active: AgentsPanel,
  onSelect: (panel: AgentsPanel) => void,
  counts: Record<string, number | null>,
) {
  const tabs: Array<{ id: AgentsPanel; label: string }> = [
    { id: "overview", label: t("agents.tabs.overview") },
    { id: "files", label: t("agents.tabs.files") },
    { id: "tools", label: t("agents.tabs.tools") },
    { id: "skills", label: t("agents.tabs.skills") },
    { id: "channels", label: t("agents.tabs.channels") },
    { id: "cron", label: t("agents.tabs.cronJobs") },
    { id: "memory", label: t("agents.tabs.memory") },
  ];
  return renderHubTabs({
    id: "agents",
    active,
    tabs: tabs.map((tab) => ({
      value: tab.id,
      label: tab.label,
      count: counts[tab.id],
    })),
    ariaLabel: t("tabs.agents"),
    panelId: "agent-panel",
    onSelect,
  });
}
