import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { AgentsListResult, GatewaySessionRow, SessionBranch } from "../../api/types.ts";
import type { ApplicationInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { SessionCapability, SessionMessageSubscription } from "../../lib/sessions/index.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { ChatRunStartupState } from "./chat-run-startup.ts";
import type { LocalTerminalReconcile } from "./run-lifecycle.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { PlanStatus } from "./tool-stream.ts";

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: AgentsListResult["agents"];
};

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  initialUserMessage?: ApplicationInitialUserMessageHandoff;
  /** Monotonic owner epoch; reconnects can reuse the same client object. */
  connectionEpoch: number;
  sessionKey: string;
  currentSessionId?: string | null;
  reconnectResumeSessionId?: string | null;
  chatLoading: boolean;
  chatHistoryPagination?: ChatHistoryPagination;
  chatMessages: unknown[];
  chatMessagesBySession?: ChatMessageCache;
  /** Active leaf of the history snapshot currently rendered by this pane. */
  chatDisplayedLeafEntryId?: string | null;
  chatThinkingLevel: string | null;
  chatVerboseLevel: string | null;
  /** Pane-owned explicit session queue override from the latest history response. */
  chatQueueModeOverride?: GatewaySessionRow["queueMode"];
  /** Pane-owned effective queue mode from this session's latest history response. */
  chatEffectiveQueueMode?: GatewaySessionRow["effectiveQueueMode"];
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatRunUsageById?: Map<string, number>;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunStartup?: ChatRunStartupState | null;
  planStatus?: PlanStatus | null;
  lastError: string | null;
  chatError?: string | null;
  chatRunError?: { summary: string } | null;
  lastLocalTerminalReconcile?: LocalTerminalReconcile | null;
  chatReplyTarget?: unknown;
  agentsError?: string | null;
  onAgentsList?: (agentsList: AgentsListResult, client: GatewayBrowserClient) => boolean;
  resetChatInputHistoryNavigation?: () => void;
  assistantAgentId?: string | null;
  agentsList?: ChatAgentsListSnapshot | null;
  agentsSelectedId?: string | null;
  hello: GatewayHelloOk | null;
  canvasPluginSurfaceUrl?: string | null;
  settings?: { chatPersistCommentary?: boolean; gatewayUrl?: string | null };
  sessions?: Partial<SessionCapability>;
  chatSessionMessageSubscriptionRequestedKey?: string | null;
  chatSessionMessageSubscription?: SessionMessageSubscription | null;
  chatBranches?: SessionBranch[];
  chatBranchesSessionKey?: string | null;
  chatBranchesConnectionEpoch?: number | null;
  requestUpdate?: () => void;
};
