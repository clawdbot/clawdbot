import { html, nothing } from "lit";

import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import type { AppViewState } from "./app-view-state";
import {
  TAB_GROUPS,
  iconForTab,
  pathForTab,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "./navigation";
import type { UiSettings } from "./storage";
import type { ThemeMode } from "./theme";
import type { ThemeTransitionContext } from "./theme-transition";
import type {
  ConfigSnapshot,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import type {
  ChatQueueItem,
  CronFormState,
  DiscordForm,
  IMessageForm,
  SlackForm,
  SignalForm,
  TelegramForm,
} from "./ui-types";
import { renderChat } from "./views/chat";
import { renderConfig } from "./views/config";
import { renderConnections } from "./views/connections";
import { renderCron } from "./views/cron";
import { renderDebug } from "./views/debug";
import { renderInstances } from "./views/instances";
import { renderLogs } from "./views/logs";
import { renderNodes } from "./views/nodes";
import { renderOverview } from "./views/overview";
import { renderSessions } from "./views/sessions";
import { renderSkills } from "./views/skills";
import { renderChatControls, renderTab, renderThemeToggle } from "./app-render.helpers";
import {
  loadChannels,
  updateDiscordForm,
  updateIMessageForm,
  updateSlackForm,
  updateSignalForm,
  updateTelegramForm,
} from "./controllers/connections";
import { loadPresence } from "./controllers/presence";
import { loadSessions, patchSession } from "./controllers/sessions";
import {
  installSkill,
  loadSkills,
  saveSkillApiKey,
  updateSkillEdit,
  updateSkillEnabled,
  type SkillMessage,
} from "./controllers/skills";
import { loadNodes } from "./controllers/nodes";
import { loadChatHistory } from "./controllers/chat";
import {
  applyConfig,
  loadConfig,
  runUpdate,
  saveConfig,
  updateConfigFormValue,
} from "./controllers/config";
import { loadCronRuns, toggleCronJob, runCronJob, removeCronJob, addCronJob } from "./controllers/cron";
import { loadDebug, callDebugMethod } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";

export function renderApp(state: AppViewState) {
  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;
  const chatDisabledReason = state.connected ? null : "Disconnected from gateway.";
  const isChat = state.tab === "chat";
  const chatFocus = isChat && state.settings.chatFocusMode;

  return html`
    <div class="shell ${isChat ? "shell--chat" : ""} ${chatFocus ? "shell--chat-focus" : ""} ${state.settings.navCollapsed ? "shell--nav-collapsed" : ""}">
      <header class="topbar">
        <div class="topbar-left">
          <button
            class="nav-collapse-toggle"
            @click=${() =>
              state.applySettings({
                ...state.settings,
                navCollapsed: !state.settings.navCollapsed,
              })}
            title="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
            aria-label="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
          >
            <span class="nav-collapse-toggle__icon">☰</span>
          </button>
          <div class="brand">
            <div class="brand-title">CLAWDBOT</div>
            <div class="brand-sub">Gateway Dashboard</div>
          </div>
        </div>
        <div class="topbar-status">
          <div class="pill">
            <span class="statusDot ${state.connected ? "ok" : ""}"></span>
            <span>Health</span>
            <span class="mono">${state.connected ? "OK" : "Offline"}</span>
          </div>
          ${renderThemeToggle(state)}
        </div>
      </header>
      <aside class="nav ${state.settings.navCollapsed ? "nav--collapsed" : ""}">
        ${TAB_GROUPS.map((group) => {
          const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
          const hasActiveTab = group.tabs.some((tab) => tab === state.tab);
          return html`
            <div class="nav-group ${isGroupCollapsed && !hasActiveTab ? "nav-group--collapsed" : ""}">
              <button
                class="nav-label"
                @click=${() => {
                  const next = { ...state.settings.navGroupsCollapsed };
                  next[group.label] = !isGroupCollapsed;
                  state.applySettings({
                    ...state.settings,
                    navGroupsCollapsed: next,
                  });
                }}
                aria-expanded=${!isGroupCollapsed}
              >
                <span class="nav-label__text">${group.label}</span>
                <span class="nav-label__chevron">${isGroupCollapsed ? "+" : "−"}</span>
              </button>
              <div class="nav-group__items">
                ${group.tabs.map((tab) => renderTab(state, tab))}
              </div>
            </div>
          `;
        })}
        <div class="nav-group nav-group--links">
          <div class="nav-label nav-label--static">
            <span class="nav-label__text">Resources</span>
          </div>
          <div class="nav-group__items">
            <a
              class="nav-item nav-item--external"
              href="https://docs.clawd.bot"
              target="_blank"
              rel="noreferrer"
              title="Docs (opens in new tab)"
            >
              <span class="nav-item__icon" aria-hidden="true">📚</span>
              <span class="nav-item__text">Docs</span>
            </a>
          </div>
        </div>
      </aside>
      <main class="content ${isChat ? "content--chat" : ""}">
        <section class="content-header">
          <div>
            <div class="page-title">${titleForTab(state.tab)}</div>
            <div class="page-sub">${subtitleForTab(state.tab)}</div>
          </div>
          <div class="page-meta">
            ${state.lastError
              ? html`<div class="pill danger">${state.lastError}</div>`
              : nothing}
            ${isChat ? renderChatControls(state) : nothing}
          </div>
        </section>

        ${state.tab === "overview"
          ? renderOverview({
              connected: state.connected,
              hello: state.hello,
              settings: state.settings,
              password: state.password,
              lastError: state.lastError,
              presenceCount,
              sessionsCount,
              cronEnabled: state.cronStatus?.enabled ?? null,
              cronNext,
              lastChannelsRefresh: state.channelsLastSuccess,
              onSettingsChange: (next) => state.applySettings(next),
              onPasswordChange: (next) => (state.password = next),
              onSessionKeyChange: (next) => {
                state.sessionKey = next;
                state.chatMessage = "";
                state.resetToolStream();
                state.applySettings({
                  ...state.settings,
                  sessionKey: next,
                  lastActiveSessionKey: next,
                });
              },
              onConnect: () => state.connect(),
              onRefresh: () => state.loadOverview(),
            })
          : nothing}

        ${state.tab === "connections"
          ? renderConnections({
              connected: state.connected,
              loading: state.channelsLoading,
              snapshot: state.channelsSnapshot,
              lastError: state.channelsError,
              lastSuccessAt: state.channelsLastSuccess,
              whatsappMessage: state.whatsappLoginMessage,
              whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
              whatsappConnected: state.whatsappLoginConnected,
              whatsappBusy: state.whatsappBusy,
              telegramForm: state.telegramForm,
              telegramTokenLocked: state.telegramTokenLocked,
              telegramSaving: state.telegramSaving,
              telegramStatus: state.telegramConfigStatus,
              discordForm: state.discordForm,
              discordTokenLocked: state.discordTokenLocked,
              discordSaving: state.discordSaving,
              discordStatus: state.discordConfigStatus,
              slackForm: state.slackForm,
              slackTokenLocked: state.slackTokenLocked,
              slackAppTokenLocked: state.slackAppTokenLocked,
              slackSaving: state.slackSaving,
              slackStatus: state.slackConfigStatus,
              signalForm: state.signalForm,
              signalSaving: state.signalSaving,
              signalStatus: state.signalConfigStatus,
              imessageForm: state.imessageForm,
              imessageSaving: state.imessageSaving,
              imessageStatus: state.imessageConfigStatus,
              onRefresh: (probe) => loadChannels(state, probe),
              onWhatsAppStart: (force) => state.handleWhatsAppStart(force),
              onWhatsAppWait: () => state.handleWhatsAppWait(),
              onWhatsAppLogout: () => state.handleWhatsAppLogout(),
              onTelegramChange: (patch) => updateTelegramForm(state, patch),
              onTelegramSave: () => state.handleTelegramSave(),
              onDiscordChange: (patch) => updateDiscordForm(state, patch),
              onDiscordSave: () => state.handleDiscordSave(),
              onSlackChange: (patch) => updateSlackForm(state, patch),
              onSlackSave: () => state.handleSlackSave(),
              onSignalChange: (patch) => updateSignalForm(state, patch),
              onSignalSave: () => state.handleSignalSave(),
              onIMessageChange: (patch) => updateIMessageForm(state, patch),
              onIMessageSave: () => state.handleIMessageSave(),
            })
          : nothing}

        ${state.tab === "instances"
          ? renderInstances({
              loading: state.presenceLoading,
              entries: state.presenceEntries,
              lastError: state.presenceError,
              statusMessage: state.presenceStatus,
              onRefresh: () => loadPresence(state),
            })
          : nothing}

        ${state.tab === "sessions"
          ? renderSessions({
              loading: state.sessionsLoading,
              result: state.sessionsResult,
              error: state.sessionsError,
              activeMinutes: state.sessionsFilterActive,
              limit: state.sessionsFilterLimit,
              includeGlobal: state.sessionsIncludeGlobal,
              includeUnknown: state.sessionsIncludeUnknown,
              basePath: state.basePath,
              onFiltersChange: (next) => {
                state.sessionsFilterActive = next.activeMinutes;
                state.sessionsFilterLimit = next.limit;
                state.sessionsIncludeGlobal = next.includeGlobal;
                state.sessionsIncludeUnknown = next.includeUnknown;
              },
              onRefresh: () => loadSessions(state),
              onPatch: (key, patch) => patchSession(state, key, patch),
            })
          : nothing}

        ${state.tab === "cron"
          ? renderCron({
              loading: state.cronLoading,
              status: state.cronStatus,
              jobs: state.cronJobs,
              error: state.cronError,
              busy: state.cronBusy,
              form: state.cronForm,
              runsJobId: state.cronRunsJobId,
              runs: state.cronRuns,
              onFormChange: (patch) => (state.cronForm = { ...state.cronForm, ...patch }),
              onRefresh: () => state.loadCron(),
              onAdd: () => addCronJob(state),
              onToggle: (job, enabled) => toggleCronJob(state, job, enabled),
              onRun: (job) => runCronJob(state, job),
              onRemove: (job) => removeCronJob(state, job),
              onLoadRuns: (jobId) => loadCronRuns(state, jobId),
            })
          : nothing}

        ${state.tab === "skills"
          ? renderSkills({
              loading: state.skillsLoading,
              report: state.skillsReport,
              error: state.skillsError,
              filter: state.skillsFilter,
              edits: state.skillEdits,
              messages: state.skillMessages,
              busyKey: state.skillsBusyKey,
              onFilterChange: (next) => (state.skillsFilter = next),
              onRefresh: () => loadSkills(state, { clearMessages: true }),
              onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
              onEdit: (key, value) => updateSkillEdit(state, key, value),
              onSaveKey: (key) => saveSkillApiKey(state, key),
              onInstall: (skillKey, name, installId) =>
                installSkill(state, skillKey, name, installId),
            })
          : nothing}

        ${state.tab === "nodes"
          ? renderNodes({
              loading: state.nodesLoading,
              nodes: state.nodes,
              onRefresh: () => loadNodes(state),
            })
          : nothing}

        ${state.tab === "chat"
          ? renderChat({
              sessionKey: state.sessionKey,
              onSessionKeyChange: (next) => {
                state.sessionKey = next;
                state.chatMessage = "";
                state.chatStream = null;
                state.chatStreamStartedAt = null;
                state.chatRunId = null;
                state.chatQueue = [];
                state.resetToolStream();
                state.resetChatScroll();
                state.applySettings({
                  ...state.settings,
                  sessionKey: next,
                  lastActiveSessionKey: next,
                });
                void loadChatHistory(state);
              },
              thinkingLevel: state.chatThinkingLevel,
              loading: state.chatLoading,
              sending: state.chatSending,
              messages: state.chatMessages,
              toolMessages: state.chatToolMessages,
              stream: state.chatStream,
              streamStartedAt: state.chatStreamStartedAt,
              draft: state.chatMessage,
              queue: state.chatQueue,
              connected: state.connected,
              canSend: state.connected,
              disabledReason: chatDisabledReason,
              error: state.lastError,
              sessions: state.sessionsResult,
              isToolOutputExpanded: (id) => state.toolOutputExpanded.has(id),
              onToolOutputToggle: (id, expanded) =>
                state.toggleToolOutput(id, expanded),
              focusMode: state.settings.chatFocusMode,
              useNewChatLayout: state.settings.useNewChatLayout,
              onRefresh: () => {
                state.resetToolStream();
                return loadChatHistory(state);
              },
              onToggleFocusMode: () =>
                state.applySettings({
                  ...state.settings,
                  chatFocusMode: !state.settings.chatFocusMode,
                }),
              onToggleLayout: () =>
                state.applySettings({
                  ...state.settings,
                  useNewChatLayout: !state.settings.useNewChatLayout,
                }),
              onChatScroll: (event) => state.handleChatScroll(event),
              onDraftChange: (next) => (state.chatMessage = next),
              onSend: () => state.handleSendChat(),
              canAbort: Boolean(state.chatRunId),
              onAbort: () => void state.handleAbortChat(),
              onQueueRemove: (id) => state.removeQueuedMessage(id),
              onNewSession: () =>
                state.handleSendChat("/new", { restoreDraft: true }),
              // Sidebar props for tool output viewing
              sidebarOpen: state.sidebarOpen,
              sidebarContent: state.sidebarContent,
              sidebarError: state.sidebarError,
              splitRatio: state.splitRatio,
              onOpenSidebar: (content: string) => state.handleOpenSidebar(content),
              onCloseSidebar: () => state.handleCloseSidebar(),
              onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
            })
          : nothing}

        ${state.tab === "config"
          ? renderConfig({
              raw: state.configRaw,
              valid: state.configValid,
              issues: state.configIssues,
              loading: state.configLoading,
              saving: state.configSaving,
              applying: state.configApplying,
              updating: state.updateRunning,
              connected: state.connected,
              schema: state.configSchema,
              schemaLoading: state.configSchemaLoading,
              uiHints: state.configUiHints,
              formMode: state.configFormMode,
              formValue: state.configForm,
              onRawChange: (next) => (state.configRaw = next),
              onFormModeChange: (mode) => (state.configFormMode = mode),
              onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
              onReload: () => loadConfig(state),
              onSave: () => saveConfig(state),
              onApply: () => applyConfig(state),
              onUpdate: () => runUpdate(state),
            })
          : nothing}

        ${state.tab === "debug"
          ? renderDebug({
              loading: state.debugLoading,
              status: state.debugStatus,
              health: state.debugHealth,
              models: state.debugModels,
              heartbeat: state.debugHeartbeat,
              eventLog: state.eventLog,
              callMethod: state.debugCallMethod,
              callParams: state.debugCallParams,
              callResult: state.debugCallResult,
              callError: state.debugCallError,
              onCallMethodChange: (next) => (state.debugCallMethod = next),
              onCallParamsChange: (next) => (state.debugCallParams = next),
              onRefresh: () => loadDebug(state),
              onCall: () => callDebugMethod(state),
            })
          : nothing}

        ${state.tab === "logs"
          ? renderLogs({
              loading: state.logsLoading,
              error: state.logsError,
              file: state.logsFile,
              entries: state.logsEntries,
              filterText: state.logsFilterText,
              levelFilters: state.logsLevelFilters,
              autoFollow: state.logsAutoFollow,
              truncated: state.logsTruncated,
              onFilterTextChange: (next) => (state.logsFilterText = next),
              onLevelToggle: (level, enabled) => {
                state.logsLevelFilters = { ...state.logsLevelFilters, [level]: enabled };
              },
              onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
              onRefresh: () => loadLogs(state, { reset: true }),
              onExport: (lines, label) => state.exportLogs(lines, label),
              onScroll: (event) => state.handleLogsScroll(event),
            })
          : nothing}
      </main>
    </div>
  `;
}
