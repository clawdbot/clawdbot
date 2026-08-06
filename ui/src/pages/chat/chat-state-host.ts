import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type {
  AgentsListResult,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import type { ChatState } from "./chat-history.ts";
import type { ChatRealtimeState } from "./chat-realtime.ts";
import type { ChatSendTimingEntry } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatProps } from "./chat-view.ts";
import type { BackgroundTasksHost } from "./components/chat-background-tasks.ts";
import type { SessionWorkspaceHost } from "./components/chat-session-workspace.ts";
import type { SidebarContent } from "./components/chat-sidebar.ts";
import type { ChatComposerDraftRetry } from "./composer-persistence.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./input-history.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import type { PendingChatAbort } from "./run-lifecycle.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SidebarLayout } from "./sidebar-layout.ts";
import type {
  CompactionStatus,
  FallbackStatus,
  PlanStatus,
  ToolStreamEntry,
  WaitingApprovalStatus,
} from "./tool-stream.ts";

export type ChatComposerMemoryFallback = {
  message: string;
  attachments: ChatAttachment[];
  storageFailed: boolean;
  draftRetry?: ChatComposerDraftRetry;
  sequence: number;
};

export type ChatPageHost = ChatHost &
  ChatState &
  ChatRealtimeState &
  SessionWorkspaceHost &
  BackgroundTasksHost & {
    initialUserMessage: ApplicationContext["initialUserMessage"];
    password: string;
    onboarding: boolean;
    assistantName: string;
    assistantAvatar: string | null;
    assistantAvatarStatus: "none" | "local" | "remote" | "data" | null;
    assistantAvatarReason: string | null;
    assistantAvatarSource: string | null;
    assistantIdentityRequestVersion: number;
    userName: string | null;
    userAvatar: string | null;
    localMediaPreviewRoots: string[];
    embedSandboxMode: EmbedSandboxMode;
    allowExternalEmbedUrls: boolean;
    chatToolMessages: Record<string, unknown>[];
    chatComposerFallbackByScope: Record<string, ChatComposerMemoryFallback>;
    chatSendingScopeKey: string | null;
    chatMessagesBySession: ChatMessageCache;
    basePath: string;
    chatAvatarUrl: string | null;
    chatAvatarSource: string | null;
    chatAvatarStatus: "none" | "local" | "remote" | "data" | null;
    chatAvatarReason: string | null;
    chatModelSwitchPromises: Record<string, Promise<boolean>>;
    chatModelCatalog: ModelCatalogEntry[];
    modelAuthStatusResult: ModelAuthStatusResult | null;
    modelAuthStatusError: string | null;
    sessionsResult: SessionsListResult | null;
    sessionsResultAgentId: string | null;
    sessionsError: string | null;
    sessionsArchivedFilter: "active" | "archived" | "all";
    selectedChatSessionArchived: boolean;
    agentsList: AgentsListResult | null;
    agentsSelectedId: string | null;
    pendingAbort: PendingChatAbort | null;
    pendingSessionMessageReloadSessionKey: string | null;
    chatSubmitGuards: Map<string, Promise<void>>;
    chatSendTimingsByRun: Map<string, ChatSendTimingEntry>;
    chatStreamSegments: Array<{ text: string; ts: number }>;
    toolStreamById: Map<string, ToolStreamEntry>;
    toolStreamOrder: string[];
    toolStreamSyncTimer: number | null;
    compactionStatus: CompactionStatus | null;
    fallbackStatus: FallbackStatus | null;
    planStatus: PlanStatus | null;
    observerDigest: SessionObserverDigest | null;
    knownAgentRunIds: Set<string>;
    /** `sessionKey|runId` scopes that already forced a PR-chips refresh mid-stream. */
    streamPullRequestRefreshKeys?: Set<string>;
    /** Rolling stream suffix so a PR URL split across delta chunks still matches. */
    streamPullRequestTail?: { scope: string; text: string };
    waitingApprovalStatuses: Map<string, WaitingApprovalStatus>;
    waitingApprovalResolvedIds: Set<string>;
    chatRunStatus: ChatProps["runStatus"];
    chatNewMessagesBelow: boolean;
    chatMetadataRequestVersion: number;
    chatModelsLoading: boolean;
    chatViewMenuOpen: boolean;
    chatViewMenuTrigger: HTMLElement | null;
    sessionsLoading: boolean;
    lastErrorCode: string | null;
    chatScrollCommitCleanup: (() => void) | null;
    chatStreamRenderFrame: number | null;
    chatScrollFrame: number | null;
    chatScrollGuardFrame: number | null;
    chatScrollGeneration: number;
    chatLastScrollTop: number;
    chatLastScrollHeight: number;
    chatHasAutoScrolled: boolean;
    chatUserNearBottom: boolean;
    chatFollowLocked: boolean;
    chatIsProgrammaticScroll: boolean;
    chatProgrammaticScrollTarget: number;
    chatScrollToEnd?: (options: { behavior?: ScrollBehavior }) => void;
    sidebarLayout: SidebarLayout;
    sidebarContent: SidebarContent | null;
    sidebarFocusPanelId: string;
    sidebarFocusVersion: number;
    updateSidebarActivePanel: (panelId: string) => void;
    imageLightbox: ImageLightboxItem | null;
    imageLightboxRequestVersion: number;
    querySelector: (selectors: string) => Element | null;
    renderLifecycle: RenderLifecycle;
    onModelChanged: () => Promise<void> | void;
    resetToolStream: () => void;
    resetChatScroll: () => void;
    resetChatInputHistoryNavigation: () => void;
    scrollToBottom: (opts?: { smooth?: boolean }) => void;
    setChatViewMenuOpen: (
      open: boolean,
      options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
    ) => void;
    loadAssistantIdentity: () => Promise<void>;
    applySettings: (patch: Partial<UiSettings>) => void;
    handleChatScroll: (event: Event) => void;
    handleChatDraftChange: (next: string) => void;
    handleChatInputHistoryKey: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
    handleSendChat: (messageOverride?: string, options?: unknown) => Promise<void>;
    handleAbortChat: (options?: unknown) => Promise<void>;
    removeQueuedMessage: (id: string) => void;
    retryQueuedChatMessage: (id: string) => Promise<void>;
    steerQueuedChatMessage: (id: string) => Promise<void>;
    handleCloseSidebar: () => void;
    updateSidebarLayout: (layout: SidebarLayout) => void;
    beginImageOpen: () => number;
    handleOpenImage: (item: ImageLightboxItem, requestVersion?: number) => void;
    handleCloseImage: () => void;
    announceSessionSwitch?: (sessionKey: string, label: string) => void;
    createChatSession?: () => Promise<boolean>;
    confirmConversationReset?: () => Promise<boolean>;
    exportCurrentChat?: () => Promise<void> | void;
    refreshCurrentSessionTools?: () => Promise<void>;
    refreshCurrentChat?: () => Promise<void>;
    refreshSessionPullRequests?: (options?: { refresh?: boolean }) => Promise<void>;
  };
