import { LitElement } from "lit";
import { state } from "lit/decorators.js";
import { i18n, I18nController, isSupportedLocale, t } from "../i18n/index.ts";
import {
  handleChannelConfigReload as handleChannelConfigReloadInternal,
  handleChannelConfigSave as handleChannelConfigSaveInternal,
  handleNostrProfileCancel as handleNostrProfileCancelInternal,
  handleNostrProfileEdit as handleNostrProfileEditInternal,
  handleNostrProfileFieldChange as handleNostrProfileFieldChangeInternal,
  handleNostrProfileImport as handleNostrProfileImportInternal,
  handleNostrProfileSave as handleNostrProfileSaveInternal,
  handleNostrProfileToggleAdvanced as handleNostrProfileToggleAdvancedInternal,
  handleWhatsAppLogout as handleWhatsAppLogoutInternal,
  handleWhatsAppStart as handleWhatsAppStartInternal,
  handleWhatsAppWait as handleWhatsAppWaitInternal,
} from "./app-channels.ts";
import {
  handleAbortChat as handleAbortChatInternal,
  handleChatDraftChange as handleChatDraftChangeInternal,
  handleChatInputHistoryKey as handleChatInputHistoryKeyInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
  resetChatInputHistoryNavigation as resetChatInputHistoryNavigationInternal,
  steerQueuedChatMessage as steerQueuedChatMessageInternal,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
} from "./app-chat.ts";
import {
  DEFAULT_CRON_FORM,
  DEFAULT_LOG_LEVEL_FILTERS,
  DEFAULT_SESSIONS_FILTERS,
} from "./app-defaults.ts";
import type { EventLogEntry } from "./app-events.ts";
import { connectGateway as connectGatewayInternal } from "./app-gateway.ts";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle.ts";
import { createChatSession as createChatSessionInternal } from "./app-render.helpers.ts";
import { renderApp } from "./app-render.ts";
import {
  exportLogs as exportLogsInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
  scheduleChatScroll as scheduleChatScrollInternal,
} from "./app-scroll.ts";
import {
  applySettings as applySettingsInternal,
  applyLocalUserIdentity as applyLocalUserIdentityInternal,
  loadCron as loadCronInternal,
  loadOverview as loadOverviewInternal,
  setTab as setTabInternal,
  setTheme as setThemeInternal,
  setThemeMode as setThemeModeInternal,
  onPopState as onPopStateInternal,
} from "./app-settings.ts";
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
  type CompactionStatus,
  type FallbackStatus,
} from "./app-tool-stream.ts";
import type { AppViewState } from "./app-view-state.ts";
import { normalizeAssistantIdentity } from "./assistant-identity.ts";
import { exportChatMarkdown } from "./chat/export.ts";
import { RealtimeTalkSession, type RealtimeTalkStatus } from "./chat/realtime-talk.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import {
  loadToolsEffective as loadToolsEffectiveInternal,
  refreshVisibleToolsEffectiveForCurrentSession as refreshVisibleToolsEffectiveForCurrentSessionInternal,
} from "./controllers/agents.ts";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type {
  DreamingStatus,
  WikiImportInsights,
  WikiMemoryPalace,
} from "./controllers/dreaming.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type {
  ClawHubSearchResult,
  ClawHubSkillDetail,
  SkillMessage,
} from "./controllers/skills.ts";
import { importCustomThemeFromUrl } from "./custom-theme.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import { resolveAgentIdFromSessionKey } from "./session-key.ts";
import type { SidebarContent } from "./sidebar-content.ts";
import { loadLocalUserIdentity, loadSettings, type UiSettings } from "./storage.ts";
import { VALID_THEME_NAMES, type ResolvedTheme, type ThemeMode, type ThemeName } from "./theme.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ConfigSnapshot,
  ConfigUiHints,
  ChatModelOverride,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSummary,
  LogEntry,
  LogLevel,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionCompactionCheckpoint,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
  NostrProfile,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "./types.ts";
import { type ChatAttachment, type ChatQueueItem, type CronFormState } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";

declare global {
  interface Window {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  }
}

const bootAssistantIdentity = normalizeAssistantIdentity({});
const bootLocalUserIdentity = loadLocalUserIdentity();

function resolveOnboardingMode(): boolean {
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export class OpenClawApp extends LitElement {
  private i18nController = new I18nController(this);
  clientInstanceId = generateUUID();
  connectGeneration = 0;
  @state() settings: UiSettings = loadSettings();
  constructor() {
    super();
    if (isSupportedLocale(this.settings.locale)) {
      void i18n.setLocale(this.settings.locale);
    }
  }
  @state() password = "";
  @state() loginShowGatewayToken = false;
  @state() loginShowGatewayPassword = false;
  @state() tab: Tab = "chat";
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeName = this.settings.theme ?? "claw";
  @state() themeMode: ThemeMode = this.settings.themeMode ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() themeOrder: ThemeName[] = this.buildThemeOrder(this.theme);
  @state() customThemeImportUrl = "";
  @state() customThemeImportBusy = false;
  @state() customThemeImportMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() customThemeImportExpanded = false;
  @state() customThemeImportFocusToken = 0;
  private customThemeImportSelectOnSuccess = false;
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() lastErrorCode: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  @state() assistantName = bootAssistantIdentity.name;
  @state() assistantAvatar = bootAssistantIdentity.avatar;
  @state() assistantAvatarSource = bootAssistantIdentity.avatarSource ?? null;
  @state() assistantAvatarStatus = bootAssistantIdentity.avatarStatus ?? null;
  @state() assistantAvatarReason = bootAssistantIdentity.avatarReason ?? null;
  @state() assistantAvatarUploadBusy = false;
  @state() assistantAvatarUploadError: string | null = null;
  @state() assistantAgentId = bootAssistantIdentity.agentId ?? null;
  @state() userName = bootLocalUserIdentity.name;
  @state() userAvatar = bootLocalUserIdentity.avatar;
  @state() localMediaPreviewRoots: string[] = [];
  @state() embedSandboxMode: "strict" | "scripts" | "trusted" = "scripts";
  @state() allowExternalEmbedUrls = false;
  @state() chatMessageMaxWidth: string | null = null;
  @state() serverVersion: string | null = null;

  @state() sessionKey = this.settings.sessionKey;
  currentSessionId: string | null = null;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  @state() chatStreamSegments: Array<{ text: string; ts: number }> = [];
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() chatSideResult: ChatSideResult | null = null;
  @state() compactionStatus: CompactionStatus | null = null;
  @state() fallbackStatus: FallbackStatus | null = null;
  @state() chatAvatarUrl: string | null = null;
  @state() chatAvatarSource: string | null = null;
  @state() chatAvatarStatus: "none" | "local" | "remote" | "data" | null = null;
  @state() chatAvatarReason: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatModelOverrides: Record<string, ChatModelOverride | null> = {};
  @state() chatModelsLoading = false;
  @state() chatModelCatalog: ModelCatalogEntry[] = [];
  @state() sessionSwitchNotice: { id: number; text: string } | null = null;
  @state() sessionSwitchFlashKey: string | null = null;
  private sessionSwitchNoticeSeq = 0;
  private sessionSwitchNoticeTimer: number | null = null;
  private sessionSwitchFlashTimer: number | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatQueueBySession: Record<string, ChatQueueItem[]> = {};
  @state() chatAttachments: ChatAttachment[] = [];
  @state() realtimeTalkActive = false;
  @state() realtimeTalkStatus: RealtimeTalkStatus = "idle";
  @state() realtimeTalkDetail: string | null = null;
  @state() realtimeTalkTranscript: string | null = null;
  private realtimeTalkSession: RealtimeTalkSession | null = null;
  @state() chatManualRefreshInFlight = false;
  @state() chatHeaderControlsHidden = false;
  @state() chatMobileControlsOpen = false;
  private chatMobileControlsTrigger: HTMLElement | null = null;
  @state() navDrawerOpen = false;

  onSlashAction?: (action: string) => void | Promise<void>;
  chatLocalInputHistoryBySession: Record<string, Array<{ text: string; ts: number }>> = {};
  chatInputHistorySessionKey: string | null = null;
  chatInputHistoryItems: string[] | null = null;
  @state() chatInputHistoryIndex = -1;
  chatDraftBeforeHistory: string | null = null;

  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: SidebarContent | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() execApprovalsTargetNodeId: string | null = null;
  @state() execApprovalQueue: ExecApprovalRequest[] = [];
  @state() execApprovalBusy = false;
  @state() execApprovalError: string | null = null;
  @state() pendingGatewayUrl: string | null = null;
  pendingGatewayToken: string | null = null;

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configRawOriginal = "";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() updateRunning = false;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configSchema: unknown = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;
  @state() dreamingStatusLoading = false;
  @state() dreamingStatusError: string | null = null;
  @state() dreamingStatus: DreamingStatus | null = null;
  @state() dreamingModeSaving = false;
  @state() dreamingRestartConfirmOpen = false;
  @state() dreamingRestartConfirmLoading = false;
  @state() dreamingPendingEnabled: boolean | null = null;
  @state() dreamDiaryLoading = false;
  @state() dreamDiaryActionLoading = false;
  @state() dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() dreamDiaryActionArchivePath: string | null = null;
  @state() dreamDiaryError: string | null = null;
  @state() dreamDiaryPath: string | null = null;
  @state() dreamDiaryContent: string | null = null;
  @state() wikiImportInsightsLoading = false;
  @state() wikiImportInsightsError: string | null = null;
  @state() wikiImportInsights: WikiImportInsights | null = null;
  @state() wikiMemoryPalaceLoading = false;
  @state() wikiMemoryPalaceError: string | null = null;
  @state() wikiMemoryPalace: WikiMemoryPalace | null = null;
  @state() configFormDirty = false;
  @state() configSettingsMode: "quick" | "advanced" = "quick";
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;
  @state() pendingUpdateExpectedVersion: string | null = null;
  @state() updateStatusBanner: { tone: "danger" | "warn" | "info"; text: string } | null = null;
  @state() communicationsFormMode: "form" | "raw" = "form";
  @state() communicationsSearchQuery = "";
  @state() communicationsActiveSection: string | null = null;
  @state() communicationsActiveSubsection: string | null = null;
  @state() appearanceFormMode: "form" | "raw" = "form";
  @state() appearanceSearchQuery = "";
  @state() appearanceActiveSection: string | null = null;
  @state() appearanceActiveSubsection: string | null = null;
  @state() automationFormMode: "form" | "raw" = "form";
  @state() automationSearchQuery = "";
  @state() automationActiveSection: string | null = null;
  @state() automationActiveSubsection: string | null = null;
  @state() infrastructureFormMode: "form" | "raw" = "form";
  @state() infrastructureSearchQuery = "";
  @state() infrastructureActiveSection: string | null = null;
  @state() infrastructureActiveSubsection: string | null = null;
  @state() aiAgentsFormMode: "form" | "raw" = "form";
  @state() aiAgentsSearchQuery = "";
  @state() aiAgentsActiveSection: string | null = null;
  @state() aiAgentsActiveSubsection: string | null = null;

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() nostrProfileFormState: NostrProfileFormState | null = null;
  @state() nostrProfileAccountId: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;
  @state() agentsSelectedId: string | null = null;
  @state() toolsCatalogLoading = false;
  @state() toolsCatalogError: string | null = null;
  @state() toolsCatalogResult: ToolsCatalogResult | null = null;
  @state() toolsEffectiveLoading = false;
  @state() toolsEffectiveLoadingKey: string | null = null;
  @state() toolsEffectiveResultKey: string | null = null;
  @state() toolsEffectiveError: string | null = null;
  @state() toolsEffectiveResult: ToolsEffectiveResult | null = null;
  @state() agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron" = "files";
  @state() agentFilesLoading = false;
  @state() agentFilesError: string | null = null;
  @state() agentFilesList: AgentsFilesListResult | null = null;
  @state() agentFileContents: Record<string, string> = {};
  @state() agentFileDrafts: Record<string, string> = {};
  @state() agentFileActive: string | null = null;
  @state() agentFileSaving = false;
  @state() agentIdentityLoading = false;
  @state() agentIdentityError: string | null = null;
  @state() agentIdentityById: Record<string, AgentIdentityResult> = {};
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = DEFAULT_SESSIONS_FILTERS.activeMinutes;
  @state() sessionsFilterLimit = DEFAULT_SESSIONS_FILTERS.limit;
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;
  @state() sessionsShowArchived = false;
  @state() sessionsFiltersCollapsed = false;
  @state() sessionsHideCron = true;
  @state() sessionsSearchQuery = "";
  @state() sessionsSortColumn: "key" | "kind" | "updated" | "tokens" = "updated";
  @state() sessionsSortDir: "asc" | "desc" = "desc";
  @state() sessionsPage = 0;
  @state() sessionsPageSize = 25;
  @state() sessionsSelectedKeys: Set<string> = new Set();
  @state() sessionsExpandedCheckpointKey: string | null = null;
  @state() sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]> = {};
  @state() sessionsCheckpointLoadingKey: string | null = null;
  @state() sessionsCheckpointBusyKey: string | null = null;
  @state() sessionsCheckpointErrorByKey: Record<string, string> = {};

  @state() usageLoading = false;
  @state() usageResult: import("./types.js").SessionsUsageResult | null = null;
  @state() usageCostSummary: import("./types.js").CostUsageSummary | null = null;
  @state() usageError: string | null = null;
  @state() usageStartDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageEndDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageSelectedSessions: string[] = [];
  @state() usageSelectedDays: string[] = [];
  @state() usageSelectedHours: number[] = [];
  @state() usageChartMode: "tokens" | "cost" = "tokens";
  @state() usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeries: import("./types.js").SessionUsageTimeSeries | null = null;
  @state() usageTimeSeriesLoading = false;
  @state() usageTimeSeriesCursorStart: number | null = null;
  @state() usageTimeSeriesCursorEnd: number | null = null;
  @state() usageSessionLogs: import("./views/usage.js").SessionLogEntry[] | null = null;
  @state() usageSessionLogsLoading = false;
  @state() usageSessionLogsExpanded = false;
  // Applied query (used to filter the already-loaded sessions list client-side).
  @state() usageQuery = "";
  // Draft query text (updates immediately as the user types; applied via debounce or "Search").
  @state() usageQueryDraft = "";
  @state() usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors" = "recent";
  @state() usageSessionSortDir: "desc" | "asc" = "desc";
  @state() usageRecentSessions: string[] = [];
  @state() usageTimeZone: "local" | "utc" = "local";
  @state() usageContextExpanded = false;
  @state() usageHeaderPinned = false;
  @state() usageSessionsTab: "all" | "recent" = "all";
  @state() usageVisibleColumns: string[] = [
    "channel",
    "agent",
    "provider",
    "model",
    "messages",
    "tools",
    "errors",
    "duration",
  ];
  @state() usageLogFilterRoles: import("./views/usage.js").SessionLogRole[] = [];
  @state() usageLogFilterTools: string[] = [];
  @state() usageLogFilterHasTools = false;
  @state() usageLogFilterQuery = "";

  // Non-reactive (don’t trigger renders just for timer bookkeeping).
  usageQueryDebounceTimer: number | null = null;

  @state() cronLoading = false;
  @state() cronQuickCreateOpen = false;
  @state() cronQuickCreateStep: import("./views/cron-quick-create.ts").CronQuickCreateStep = "what";
  @state() cronQuickCreateDraft:
    | import("./views/cron-quick-create.ts").CronQuickCreateDraft
    | null = null;
  @state() cronJobsLoadingMore = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronJobsTotal = 0;
  @state() cronJobsHasMore = false;
  @state() cronJobsNextOffset: number | null = null;
  @state() cronJobsLimit = 50;
  @state() cronJobsQuery = "";
  @state() cronJobsEnabledFilter: import("./types.js").CronJobsEnabledFilter = "all";
  @state() cronJobsScheduleKindFilter: import("./controllers/cron.js").CronJobsScheduleKindFilter =
    "all";
  @state() cronJobsLastStatusFilter: import("./controllers/cron.js").CronJobsLastStatusFilter =
    "all";
  @state() cronJobsSortBy: import("./types.js").CronJobsSortBy = "nextRunAtMs";
  @state() cronJobsSortDir: import("./types.js").CronSortDir = "asc";
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronFormCollapsed = false;
  @state() cronFieldErrors: import("./controllers/cron.js").CronFieldErrors = {};
  @state() cronEditingJobId: string | null = null;
  @state() cronRunsJobId: string | null = null;
  @state() cronRunsLoadingMore = false;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronRunsTotal = 0;
  @state() cronRunsHasMore = false;
  @state() cronRunsNextOffset: number | null = null;
  @state() cronRunsLimit = 50;
  @state() cronRunsScope: import("./types.js").CronRunScope = "all";
  @state() cronRunsStatuses: import("./types.js").CronRunsStatusValue[] = [];
  @state() cronRunsDeliveryStatuses: import("./types.js").CronDeliveryStatus[] = [];
  @state() cronRunsStatusFilter: import("./types.js").CronRunsStatusFilter = "all";
  @state() cronRunsQuery = "";
  @state() cronRunsSortDir: import("./types.js").CronSortDir = "desc";
  @state() cronModelSuggestions: string[] = [];
  @state() cronBusy = false;

  @state() updateAvailable: import("./types.js").UpdateAvailable | null = null;

  // Overview dashboard state
  @state() attentionItems: import("./types.js").AttentionItem[] = [];
  @state() paletteOpen = false;
  @state() paletteQuery = "";
  @state() paletteActiveIndex = 0;
  @state() overviewShowGatewayToken = false;
  @state() overviewShowGatewayPassword = false;
  @state() overviewLogLines: string[] = [];
  @state() overviewLogCursor = 0;

  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillsStatusFilter: "all" | "ready" | "needs-setup" | "disabled" = "all";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};
  @state() skillsDetailKey: string | null = null;
  @state() clawhubSearchQuery = "";
  @state() clawhubSearchResults: ClawHubSearchResult[] | null = null;
  @state() clawhubSearchLoading = false;
  @state() clawhubSearchError: string | null = null;
  @state() clawhubDetail: ClawHubSkillDetail | null = null;
  @state() clawhubDetailSlug: string | null = null;
  @state() clawhubDetailLoading = false;
  @state() clawhubDetailError: string | null = null;
  @state() clawhubInstallSlug: string | null = null;
  @state() clawhubInstallMessage: { kind: "success" | "error"; text: string } | null = null;

  @state() healthLoading = false;
  @state() healthResult: HealthSummary | null = null;
  @state() healthError: string | null = null;

  @state() modelAuthStatusLoading = false;
  @state() modelAuthStatusResult: ModelAuthStatusResult | null = null;
  @state() modelAuthStatusError: string | null = null;

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSummary | null = null;
  @state() debugModels: ModelCatalogEntry[] = [];
  @state() debugHeartbeat: unknown = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  @state() webPushSupported = false;
  @state() webPushPermission: NotificationPermission | "unsupported" = "unsupported";
  @state() webPushSubscribed = false;
  @state() webPushLoading = false;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  private chatLastScrollTop = 0;
  private chatHasAutoScrolled = false;
  private chatUserNearBottom = true;
  @state() chatNewMessagesBelow = false;
  private nodesPollInterval: number | null = null;
  private logsPollInterval: number | null = null;
  private debugPollInterval: number | null = null;
  private logsScrollFrame: number | null = null;
  private controlUiResponsivenessObserver: { disconnect: () => void } | null = null;
  private toolStreamById = new Map<string, ToolStreamEntry>();
  private toolStreamOrder: string[] = [];
  refreshSessionsAfterChat = new Set<string>();
  chatSideResultTerminalRuns = new Set<string>();
  basePath = "";
  private popStateHandler = () =>
    onPopStateInternal(this as unknown as Parameters<typeof onPopStateInternal>[0]);
  private topbarObserver: ResizeObserver | null = null;
  private globalKeydownHandler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "k") {
      e.preventDefault();
      this.paletteOpen = !this.paletteOpen;
      if (this.paletteOpen) {
        this.paletteQuery = "";
        this.paletteActiveIndex = 0;
      }
    }
  };
  private chatMobileControlsKeydownHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !this.chatMobileControlsOpen) {
      return;
    }
    e.preventDefault();
    this.setChatMobileControlsOpen(false, { restoreFocus: true });
  };
  private chatMobileControlsPointerdownHandler = (e: Event) => {
    if (!this.chatMobileControlsOpen) {
      return;
    }
    const wrapper = this.querySelector(".chat-mobile-controls-wrapper");
    if (wrapper && e.composedPath().includes(wrapper)) {
      return;
    }
    this.setChatMobileControlsOpen(false);
  };

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.onSlashAction = async (action: string) => {
      switch (action) {
        case "new-session":
          await createChatSessionInternal(this as unknown as AppViewState);
          break;
        case "toggle-focus":
          this.applySettings({
            ...this.settings,
            chatFocusMode: !this.settings.chatFocusMode,
          });
          break;
        case "export":
          exportChatMarkdown(this.chatMessages, this.assistantName);
          break;
        case "refresh-tools-effective": {
          await refreshVisibleToolsEffectiveForCurrentSessionInternal(this);
          break;
        }
      }
    };
    document.addEventListener("keydown", this.globalKeydownHandler);
    document.addEventListener("keydown", this.chatMobileControlsKeydownHandler);
    document.addEventListener("pointerdown", this.chatMobileControlsPointerdownHandler);
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
    void this.initWebPushState();
  }

  protected firstUpdated() {
    handleFirstUpdated(this as unknown as Parameters<typeof handleFirstUpdated>[0]);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.globalKeydownHandler);
    document.removeEventListener("keydown", this.chatMobileControlsKeydownHandler);
    document.removeEventListener("pointerdown", this.chatMobileControlsPointerdownHandler);
    if (this.sessionSwitchNoticeTimer !== null) {
      window.clearTimeout(this.sessionSwitchNoticeTimer);
      this.sessionSwitchNoticeTimer = null;
    }
    if (this.sessionSwitchFlashTimer !== null) {
      window.clearTimeout(this.sessionSwitchFlashTimer);
      this.sessionSwitchFlashTimer = null;
    }
    this.chatMobileControlsTrigger = null;
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(this as unknown as Parameters<typeof handleUpdated>[0], changed);
    // Some render callbacks assign tab directly while preparing nested panel state.
    if (changed.has("tab") && this.tab !== "chat" && this.chatMobileControlsOpen) {
      this.setChatMobileControlsOpen(false);
    }
    if (!changed.has("sessionKey") || this.agentsPanel !== "tools") {
      return;
    }
    const activeSessionAgentId = resolveAgentIdFromSessionKey(this.sessionKey);
    if (this.agentsSelectedId && this.agentsSelectedId === activeSessionAgentId) {
      void loadToolsEffectiveInternal(this, {
        agentId: this.agentsSelectedId,
        sessionKey: this.sessionKey,
      });
      return;
    }
    this.toolsEffectiveResult = null;
    this.toolsEffectiveResultKey = null;
    this.toolsEffectiveError = null;
    this.toolsEffectiveLoading = false;
    this.toolsEffectiveLoadingKey = null;
  }

  connect() {
    connectGatewayInternal(this as unknown as Parameters<typeof connectGatewayInternal>[0]);
  }

  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      this as unknown as Parameters<typeof handleChatScrollInternal>[0],
      event,
    );
  }

  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(
      this as unknown as Parameters<typeof handleLogsScrollInternal>[0],
      event,
    );
  }

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  resetToolStream() {
    resetToolStreamInternal(this as unknown as Parameters<typeof resetToolStreamInternal>[0]);
  }

  resetChatScroll() {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
  }

  scrollToBottom(opts?: { smooth?: boolean }) {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
    scheduleChatScrollInternal(
      this as unknown as Parameters<typeof scheduleChatScrollInternal>[0],
      true,
      Boolean(opts?.smooth),
    );
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], next);
  }

  applyLocalUserIdentity(next: { name?: string | null; avatar?: string | null }) {
    applyLocalUserIdentityInternal(
      this as unknown as Parameters<typeof applyLocalUserIdentityInternal>[0],
      next,
    );
  }

  setTab(next: Tab) {
    setTabInternal(this as unknown as Parameters<typeof setTabInternal>[0], next);
    if (next !== "chat") {
      this.setChatMobileControlsOpen(false);
    }
    this.navDrawerOpen = false;
  }

  setChatMobileControlsOpen(
    open: boolean,
    options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
  ) {
    if (open) {
      this.chatMobileControlsTrigger = options?.trigger ?? this.chatMobileControlsTrigger;
      this.chatMobileControlsOpen = true;
      return;
    }

    const focusTarget = options?.restoreFocus ? this.chatMobileControlsTrigger : null;
    this.chatMobileControlsOpen = false;
    this.chatMobileControlsTrigger = null;
    if (!(focusTarget instanceof HTMLElement) || !focusTarget.isConnected) {
      return;
    }
    requestAnimationFrame(() => {
      if (focusTarget.isConnected) {
        focusTarget.focus();
      }
    });
  }

  setTheme(next: ThemeName, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(this as unknown as Parameters<typeof setThemeInternal>[0], next, context);
    this.themeOrder = this.buildThemeOrder(next);
  }

  setThemeMode(next: ThemeMode, context?: Parameters<typeof setThemeModeInternal>[2]) {
    setThemeModeInternal(
      this as unknown as Parameters<typeof setThemeModeInternal>[0],
      next,
      context,
    );
  }

  setCustomThemeImportUrl(next: string) {
    this.customThemeImportUrl = next;
    if (this.customThemeImportMessage?.kind === "error") {
      this.customThemeImportMessage = null;
    }
  }

  openCustomThemeImport() {
    this.customThemeImportExpanded = true;
    this.customThemeImportFocusToken += 1;
    if (!this.settings.customTheme) {
      this.customThemeImportSelectOnSuccess = true;
    }
  }

  async importCustomTheme() {
    if (this.customThemeImportBusy) {
      return;
    }
    this.customThemeImportExpanded = true;
    this.customThemeImportBusy = true;
    this.customThemeImportMessage = null;
    try {
      const customTheme = await importCustomThemeFromUrl(this.customThemeImportUrl);
      const shouldSelectImportedTheme =
        this.theme === "custom" ||
        !this.settings.customTheme ||
        this.customThemeImportSelectOnSuccess;
      applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
        ...this.settings,
        theme: shouldSelectImportedTheme ? "custom" : this.settings.theme,
        customTheme,
      });
      this.themeOrder = this.buildThemeOrder(shouldSelectImportedTheme ? "custom" : this.theme);
      this.customThemeImportUrl = "";
      this.customThemeImportSelectOnSuccess = false;
      this.customThemeImportMessage = {
        kind: "success",
        text: `Imported ${customTheme.label}.`,
      };
    } catch (error) {
      this.customThemeImportMessage = {
        kind: "error",
        text: error instanceof Error ? error.message : "Failed to import tweakcn theme.",
      };
    } finally {
      this.customThemeImportBusy = false;
    }
  }

  clearCustomTheme() {
    const nextTheme = this.theme === "custom" ? "claw" : this.theme;
    this.customThemeImportExpanded = true;
    this.customThemeImportSelectOnSuccess = false;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      theme: nextTheme,
      customTheme: undefined,
    });
    this.themeOrder = this.buildThemeOrder(nextTheme);
    this.customThemeImportMessage = {
      kind: "success",
      text: "Cleared custom theme.",
    };
  }

  setBorderRadius(value: number) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      borderRadius: value,
    });
    this.requestUpdate();
  }

  announceSessionSwitch(sessionKey: string, label: string) {
    const id = ++this.sessionSwitchNoticeSeq;
    if (this.sessionSwitchNoticeTimer !== null) {
      window.clearTimeout(this.sessionSwitchNoticeTimer);
    }
    if (this.sessionSwitchFlashTimer !== null) {
      window.clearTimeout(this.sessionSwitchFlashTimer);
    }
    this.sessionSwitchNotice = {
      id,
      text: t("chat.switchedSession", { session: label }),
    };
    this.sessionSwitchFlashKey = sessionKey;
    this.sessionSwitchFlashTimer = window.setTimeout(() => {
      if (this.sessionSwitchNotice?.id === id) {
        this.sessionSwitchFlashKey = null;
      }
      this.sessionSwitchFlashTimer = null;
    }, 200);
    this.sessionSwitchNoticeTimer = window.setTimeout(() => {
      if (this.sessionSwitchNotice?.id === id) {
        this.sessionSwitchNotice = null;
      }
      this.sessionSwitchNoticeTimer = null;
    }, 2800);
  }

  buildThemeOrder(active: ThemeName): ThemeName[] {
    const all = [...VALID_THEME_NAMES];
    const rest = all.filter((id) => id !== active);
    return [active, ...rest];
  }

  async loadOverview(opts?: { refresh?: boolean }) {
    await loadOverviewInternal(this as unknown as Parameters<typeof loadOverviewInternal>[0], opts);
  }

  async loadCron() {
    await loadCronInternal(this as unknown as Parameters<typeof loadCronInternal>[0]);
  }

  async handleAbortChat() {
    await handleAbortChatInternal(this as unknown as Parameters<typeof handleAbortChatInternal>[0]);
  }

  handleChatDraftChange(next: string) {
    handleChatDraftChangeInternal(
      this as unknown as Parameters<typeof handleChatDraftChangeInternal>[0],
      next,
    );
  }

  handleChatInputHistoryKey(input: ChatInputHistoryKeyInput): ChatInputHistoryKeyResult {
    return handleChatInputHistoryKeyInternal(
      this as unknown as Parameters<typeof handleChatInputHistoryKeyInternal>[0],
      input,
    );
  }

  resetChatInputHistoryNavigation() {
    resetChatInputHistoryNavigationInternal(
      this as unknown as Parameters<typeof resetChatInputHistoryNavigationInternal>[0],
    );
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      this as unknown as Parameters<typeof removeQueuedMessageInternal>[0],
      id,
    );
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    await handleSendChatInternal(
      this as unknown as Parameters<typeof handleSendChatInternal>[0],
      messageOverride,
      opts,
    );
  }

  async toggleRealtimeTalk() {
    if (this.realtimeTalkSession) {
      if (this.realtimeTalkStatus === "error") {
        this.realtimeTalkSession.stop();
        this.realtimeTalkSession = null;
      } else {
        this.realtimeTalkSession.stop();
        this.realtimeTalkSession = null;
        this.realtimeTalkActive = false;
        this.realtimeTalkStatus = "idle";
        this.realtimeTalkDetail = null;
        this.realtimeTalkTranscript = null;
        return;
      }
    }
    if (!this.client || !this.connected) {
      this.lastError = "Gateway not connected";
      return;
    }
    this.realtimeTalkActive = true;
    this.realtimeTalkStatus = "connecting";
    this.realtimeTalkDetail = null;
    this.realtimeTalkTranscript = null;
    const session = new RealtimeTalkSession(this.client, this.sessionKey, {
      onStatus: (status, detail) => {
        this.realtimeTalkStatus = status;
        this.realtimeTalkDetail = detail ?? null;
        if (status === "idle" || status === "error") {
          this.realtimeTalkActive = status !== "idle";
        }
      },
      onTranscript: (entry) => {
        this.realtimeTalkTranscript = `${entry.role === "user" ? "You" : "OpenClaw"}: ${entry.text}`;
      },
    });
    this.realtimeTalkSession = session;
    try {
      await session.start();
    } catch (error) {
      session.stop();
      if (this.realtimeTalkSession === session) {
        this.realtimeTalkSession = null;
      }
      this.realtimeTalkActive = false;
      this.realtimeTalkStatus = "error";
      this.realtimeTalkDetail = error instanceof Error ? error.message : String(error);
      this.lastError = this.realtimeTalkDetail;
    }
  }

  async steerQueuedChatMessage(id: string) {
    await steerQueuedChatMessageInternal(
      this as unknown as Parameters<typeof steerQueuedChatMessageInternal>[0],
      id,
    );
  }

  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      const method = active.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
      await this.client.request(method, {
        id: active.id,
        decision,
      });
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    const nextToken = this.pendingGatewayToken?.trim() || "";
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
      token: nextToken,
    });
    this.connect();
  }

  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: SidebarContent) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) {
        return;
      }
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  private async initWebPushState() {
    const supported =
      "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    this.webPushSupported = supported;
    this.webPushPermission = supported ? Notification.permission : "unsupported";
    if (supported) {
      try {
        const { getExistingSubscription } = await import("./push-subscription.ts");
        const existing = await getExistingSubscription();
        this.webPushSubscribed = existing !== null;
      } catch {
        // ignore — just means we can't check
      }
    }
  }

  /** Re-register local push subscription with the gateway after connect. */
  async reconcileWebPushState() {
    if (!this.client) {
      return;
    }
    try {
      // Always check PushManager directly — initWebPushState may not have finished
      // yet if gateway connected quickly.
      const { getExistingSubscription } = await import("./push-subscription.ts");
      const existing = await getExistingSubscription();
      if (!existing) {
        return;
      }
      this.webPushSubscribed = true;
      const subJson = existing.toJSON();
      if (subJson.endpoint && subJson.keys?.p256dh && subJson.keys?.auth) {
        await this.client.request("push.web.subscribe", {
          endpoint: subJson.endpoint,
          keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
        });
      }
    } catch {
      // Best-effort — don't block if gateway is unreachable.
    }
  }

  async handleWebPushSubscribe() {
    if (!this.client || this.webPushLoading) {
      return;
    }
    this.webPushLoading = true;
    try {
      const { subscribeToWebPush } = await import("./push-subscription.ts");
      await subscribeToWebPush(this.client);
      this.webPushSubscribed = true;
      this.webPushPermission = Notification.permission;
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.webPushLoading = false;
      // Always refresh permission state — catches denied prompts too.
      if ("Notification" in window) {
        this.webPushPermission = Notification.permission;
      }
    }
  }

  async handleWebPushUnsubscribe() {
    if (!this.client || this.webPushLoading) {
      return;
    }
    this.webPushLoading = true;
    try {
      const { unsubscribeFromWebPush } = await import("./push-subscription.ts");
      await unsubscribeFromWebPush(this.client);
      this.webPushSubscribed = false;
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.webPushLoading = false;
    }
  }

  async handleWebPushTest() {
    if (!this.client) {
      return;
    }
    try {
      const { sendTestWebPush } = await import("./push-subscription.ts");
      await sendTestWebPush(this.client);
    } catch (err) {
      this.lastError = String(err);
    }
  }

  render() {
    return renderApp(this as unknown as AppViewState);
  }
}

if (!customElements.get("openclaw-app")) {
  customElements.define("openclaw-app", OpenClawApp);
}
