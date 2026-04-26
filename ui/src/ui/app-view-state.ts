import type { EventLogEntry } from "./app-events.ts";
import type { CompactionStatus, FallbackStatus } from "./app-tool-stream.ts";
import type { RealtimeTalkStatus } from "./chat/realtime-talk.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import type { CronModelSuggestionsState, CronState } from "./controllers/cron.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type {
  ClawHubSearchResult,
  ClawHubSkillDetail,
  SkillMessage,
} from "./controllers/skills.ts";
import type { EmbedSandboxMode } from "./embed-sandbox.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { SidebarContent } from "./sidebar-content.ts";
import type { UiSettings } from "./storage.ts";
import type { ThemeTransitionContext } from "./theme-transition.ts";
import type { ResolvedTheme, ThemeMode, ThemeName } from "./theme.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  AttentionItem,
  ChannelsStatusSnapshot,
  ConfigSnapshot,
  ConfigUiHints,
  HealthSummary,
  LogEntry,
  LogLevel,
  ChatModelOverride,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  NostrProfile,
  PresenceEntry,
  SessionsUsageResult,
  CostUsageSummary,
  SessionUsageTimeSeries,
  SessionsListResult,
  SessionCompactionCheckpoint,
  SkillStatusReport,
  StatusSummary,
  ToolsCatalogResult,
} from "./types.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";
import type { SessionLogEntry } from "./views/usage.ts";

export type AppViewState = {
  settings: UiSettings;
  password: string;
  loginShowGatewayToken: boolean;
  loginShowGatewayPassword: boolean;
  tab: Tab;
  onboarding: boolean;
  basePath: string;
  connected: boolean;
  theme: ThemeName;
  themeMode: ThemeMode;
  themeResolved: ResolvedTheme;
  themeOrder: ThemeName[];
  customThemeImportUrl: string;
  customThemeImportBusy: boolean;
  customThemeImportMessage: { kind: "success" | "error"; text: string } | null;
  customThemeImportExpanded: boolean;
  customThemeImportFocusToken: number;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  lastErrorCode: string | null;
  eventLog: EventLogEntry[];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAvatarUploadBusy: boolean;
  assistantAvatarUploadError: string | null;
  assistantAgentId: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  localMediaPreviewRoots: string[];
  embedSandboxMode: EmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStreamSegments: Array<{ text: string; ts: number }>;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunId: string | null;
  chatSideResult: ChatSideResult | null;
  chatSideResultTerminalRuns: Set<string>;
  compactionStatus: CompactionStatus | null;
  fallbackStatus: FallbackStatus | null;
  chatAvatarUrl: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarReason?: string | null;
  chatThinkingLevel: string | null;
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  chatQueue: ChatQueueItem[];
  realtimeTalkActive: boolean;
  realtimeTalkStatus: RealtimeTalkStatus;
  realtimeTalkDetail: string | null;
  realtimeTalkTranscript: string | null;
  chatManualRefreshInFlight: boolean;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  chatNewMessagesBelow: boolean;
  navDrawerOpen: boolean;
  sidebarOpen: boolean;
  sidebarContent: SidebarContent | null;
  sidebarError: string | null;
  splitRatio: number;
  scrollToBottom: (opts?: { smooth?: boolean }) => void;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  execApprovalError: string | null;
  pendingGatewayUrl: string | null;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  updateRunning: boolean;
  applySessionKey: string;
  configSnapshot: ConfigSnapshot | null;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: import("./controllers/dreaming.js").DreamingStatus | null;
  dreamingModeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: import("./controllers/dreaming.js").WikiImportInsights | null;
  wikiMemoryPalaceLoading: boolean;
  wikiMemoryPalaceError: string | null;
  wikiMemoryPalace: import("./controllers/dreaming.js").WikiMemoryPalace | null;
  configFormMode: "form" | "raw";
  configSettingsMode: "quick" | "advanced";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  communicationsFormMode: "form" | "raw";
  communicationsSearchQuery: string;
  communicationsActiveSection: string | null;
  communicationsActiveSubsection: string | null;
  appearanceFormMode: "form" | "raw";
  appearanceSearchQuery: string;
  appearanceActiveSection: string | null;
  appearanceActiveSubsection: string | null;
  automationFormMode: "form" | "raw";
  automationSearchQuery: string;
  automationActiveSection: string | null;
  automationActiveSubsection: string | null;
  infrastructureFormMode: "form" | "raw";
  infrastructureSearchQuery: string;
  infrastructureActiveSection: string | null;
  infrastructureActiveSubsection: string | null;
  aiAgentsFormMode: "form" | "raw";
  aiAgentsSearchQuery: string;
  aiAgentsActiveSection: string | null;
  aiAgentsActiveSubsection: string | null;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  nostrProfileFormState: NostrProfileFormState | null;
  nostrProfileAccountId: string | null;
  configFormDirty: boolean;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  agentsSelectedId: string | null;
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveLoadingKey: string | null;
  toolsEffectiveResultKey: string | null;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: import("./types.js").ToolsEffectiveResult | null;
  agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFilesList: AgentsFilesListResult | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileActive: string | null;
  agentFileSaving: boolean;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  threadsLoading: boolean;
  threadsResult: SessionsListResult | null;
  threadsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  sessionsHideCron: boolean;
  sessionsSearchQuery: string;
  sessionsSortColumn: "key" | "kind" | "updated" | "tokens";
  sessionsSortDir: "asc" | "desc";
  sessionsPage: number;
  sessionsPageSize: number;
  sessionsSelectedKeys: Set<string>;
  sessionsExpandedCheckpointKey: string | null;
  sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  sessionsCheckpointLoadingKey: string | null;
  sessionsCheckpointBusyKey: string | null;
  sessionsCheckpointErrorByKey: Record<string, string>;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageSelectedHours: number[];
  usageChartMode: "tokens" | "cost";
  usageDailyChartMode: "total" | "by-type";
  usageTimeSeriesMode: "cumulative" | "per-turn";
  usageTimeSeriesBreakdownMode: "total" | "by-type";
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesCursorStart: number | null;
  usageTimeSeriesCursorEnd: number | null;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageSessionLogsExpanded: boolean;
  usageQuery: string;
  usageQueryDraft: string;
  usageQueryDebounceTimer: number | null;
  usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors";
  usageSessionSortDir: "asc" | "desc";
  usageRecentSessions: string[];
  usageTimeZone: "local" | "utc";
  usageContextExpanded: boolean;
  usageHeaderPinned: boolean;
  usageSessionsTab: "all" | "recent";
  usageVisibleColumns: string[];
  usageLogFilterRoles: import("./views/usage.js").SessionLogRole[];
  usageLogFilterTools: string[];
  usageLogFilterHasTools: boolean;
  usageLogFilterQuery: string;
} & Pick<
  CronState,
  | "cronLoading"
  | "cronQuickCreateOpen"
  | "cronQuickCreateStep"
  | "cronQuickCreateDraft"
  | "cronJobsLoadingMore"
  | "cronJobs"
  | "cronJobsTotal"
  | "cronJobsHasMore"
  | "cronJobsNextOffset"
  | "cronJobsLimit"
  | "cronJobsQuery"
  | "cronJobsEnabledFilter"
  | "cronJobsScheduleKindFilter"
  | "cronJobsLastStatusFilter"
  | "cronJobsSortBy"
  | "cronJobsSortDir"
  | "cronStatus"
  | "cronError"
  | "cronForm"
  | "cronFieldErrors"
  | "cronEditingJobId"
  | "cronRunsJobId"
  | "cronRunsLoadingMore"
  | "cronRuns"
  | "cronRunsTotal"
  | "cronRunsHasMore"
  | "cronRunsNextOffset"
  | "cronRunsLimit"
  | "cronRunsScope"
  | "cronRunsStatuses"
  | "cronRunsDeliveryStatuses"
  | "cronRunsStatusFilter"
  | "cronRunsQuery"
  | "cronRunsSortDir"
  | "cronBusy"
> &
  Pick<CronModelSuggestionsState, "cronModelSuggestions"> & {
    skillsLoading: boolean;
    skillsReport: SkillStatusReport | null;
    skillsError: string | null;
    skillsFilter: string;
    skillsStatusFilter: "all" | "ready" | "needs-setup" | "disabled";
    skillEdits: Record<string, string>;
    skillMessages: Record<string, SkillMessage>;
    skillsBusyKey: string | null;
    skillsDetailKey: string | null;
    clawhubSearchQuery: string;
    clawhubSearchResults: ClawHubSearchResult[] | null;
    clawhubSearchLoading: boolean;
    clawhubSearchError: string | null;
    clawhubDetail: ClawHubSkillDetail | null;
    clawhubDetailSlug: string | null;
    clawhubDetailLoading: boolean;
    clawhubDetailError: string | null;
    clawhubInstallSlug: string | null;
    clawhubInstallMessage: { kind: "success" | "error"; text: string } | null;
    healthLoading: boolean;
    healthResult: HealthSummary | null;
    healthError: string | null;
    modelAuthStatusLoading: boolean;
    modelAuthStatusResult: ModelAuthStatusResult | null;
    modelAuthStatusError: string | null;
    debugLoading: boolean;
    debugStatus: StatusSummary | null;
    debugHealth: HealthSummary | null;
    debugModels: ModelCatalogEntry[];
    debugHeartbeat: unknown;
    debugCallMethod: string;
    debugCallParams: string;
    debugCallResult: string | null;
    debugCallError: string | null;
    logsLoading: boolean;
    logsError: string | null;
    logsFile: string | null;
    logsEntries: LogEntry[];
    logsFilterText: string;
    logsLevelFilters: Record<LogLevel, boolean>;
    logsAutoFollow: boolean;
    logsTruncated: boolean;
    logsCursor: number | null;
    logsLastFetchAt: number | null;
    logsLimit: number;
    logsMaxBytes: number;
    logsAtBottom: boolean;
    updateAvailable: import("./types.js").UpdateAvailable | null;
    attentionItems: AttentionItem[];
    paletteOpen: boolean;
    paletteQuery: string;
    paletteActiveIndex: number;
    streamMode: boolean;
    overviewShowGatewayToken: boolean;
    overviewShowGatewayPassword: boolean;
    overviewLogLines: string[];
    overviewLogCursor: number;
    client: GatewayBrowserClient | null;
    refreshSessionsAfterChat: Set<string>;
    connect: () => void;
    setTab: (tab: Tab) => void;
    setTheme: (theme: ThemeName, context?: ThemeTransitionContext) => void;
    setThemeMode: (mode: ThemeMode, context?: ThemeTransitionContext) => void;
    setCustomThemeImportUrl: (next: string) => void;
    openCustomThemeImport: () => void;
    importCustomTheme: () => Promise<void>;
    clearCustomTheme: () => void;
    setBorderRadius: (value: number) => void;
    applySettings: (next: UiSettings) => void;
    applyLocalUserIdentity?: (next: { name?: string | null; avatar?: string | null }) => void;
    loadOverview: (opts?: { refresh?: boolean }) => Promise<void>;
    loadAssistantIdentity: () => Promise<void>;
    loadCron: () => Promise<void>;
    handleWhatsAppStart: (force: boolean) => Promise<void>;
    handleWhatsAppWait: () => Promise<void>;
    handleWhatsAppLogout: () => Promise<void>;
    handleChannelConfigSave: () => Promise<void>;
    handleChannelConfigReload: () => Promise<void>;
    handleNostrProfileEdit: (accountId: string, profile: NostrProfile | null) => void;
    handleNostrProfileCancel: () => void;
    handleNostrProfileFieldChange: (field: keyof NostrProfile, value: string) => void;
    handleNostrProfileSave: () => Promise<void>;
    handleNostrProfileImport: () => Promise<void>;
    handleNostrProfileToggleAdvanced: () => void;
    handleExecApprovalDecision: (decision: "allow-once" | "allow-always" | "deny") => Promise<void>;
    handleGatewayUrlConfirm: () => void;
    handleGatewayUrlCancel: () => void;
    handleConfigLoad: () => Promise<void>;
    handleConfigSave: () => Promise<void>;
    handleConfigApply: () => Promise<void>;
    handleConfigFormUpdate: (path: string, value: unknown) => void;
    handleConfigFormModeChange: (mode: "form" | "raw") => void;
    handleConfigRawChange: (raw: string) => void;
    handleInstallSkill: (key: string) => Promise<void>;
    handleUpdateSkill: (key: string) => Promise<void>;
    handleToggleSkillEnabled: (key: string, enabled: boolean) => Promise<void>;
    handleUpdateSkillEdit: (key: string, value: string) => void;
    handleSaveSkillApiKey: (key: string, apiKey: string) => Promise<void>;
    handleCronToggle: (jobId: string, enabled: boolean) => Promise<void>;
    handleCronRun: (jobId: string) => Promise<void>;
    handleCronRemove: (jobId: string) => Promise<void>;
    handleCronAdd: () => Promise<void>;
    handleCronRunsLoad: (jobId: string) => Promise<void>;
    handleCronFormUpdate: (path: string, value: unknown) => void;
    handleSessionsLoad: () => Promise<void>;
    handleSessionsPatch: (key: string, patch: unknown) => Promise<void>;
    handleLoadNodes: () => Promise<void>;
    handleLoadPresence: () => Promise<void>;
    handleLoadSkills: () => Promise<void>;
    handleLoadDebug: () => Promise<void>;
    handleLoadLogs: () => Promise<void>;
    handleDebugCall: () => Promise<void>;
    handleRunUpdate: () => Promise<void>;
    setPassword: (next: string) => void;
    setChatMessage: (next: string) => void;
    handleSendChat: (messageOverride?: string, opts?: { restoreDraft?: boolean }) => Promise<void>;
    toggleRealtimeTalk: () => Promise<void>;
    steerQueuedChatMessage: (id: string) => Promise<void>;
    handleAbortChat: () => Promise<void>;
    removeQueuedMessage: (id: string) => void;
    handleChatScroll: (event: Event) => void;
    resetToolStream: () => void;
    resetChatScroll: () => void;
    exportLogs: (lines: string[], label: string) => void;
    handleLogsScroll: (event: Event) => void;
    handleOpenSidebar: (content: SidebarContent) => void;
    handleCloseSidebar: () => void;
    handleSplitRatioChange: (ratio: number) => void;
    webPushSupported: boolean;
    webPushPermission: NotificationPermission | "unsupported";
    webPushSubscribed: boolean;
    webPushLoading: boolean;
    handleWebPushSubscribe: () => Promise<void>;
    handleWebPushUnsubscribe: () => Promise<void>;
    handleWebPushTest: () => Promise<void>;
  };
