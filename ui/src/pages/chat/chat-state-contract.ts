import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { AgentsListResult, GatewaySessionRow, SessionBranch } from "../../api/types.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { ApplicationInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { SessionCapability, SessionMessageSubscription } from "../../lib/sessions/index.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { ChatRunStartupState } from "./chat-run-startup.ts";
import type { ChatRunError, LocalTerminalReconcile } from "./run-lifecycle.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { StreamCausalBoundaryState } from "./stream-causal-boundary.ts";
import type { RunOutputUsage } from "./tool-stream.ts";

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: AgentsListResult["agents"];
};

export type ChatState = StreamCausalBoundaryState & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  initialUserMessage?: ApplicationInitialUserMessageHandoff;
  /** Monotonic owner epoch; reconnects can reuse the same client object. */
  connectionEpoch: number;
  sessionKey: string;
  currentSessionId?: string | null;
  reconnectResumeSessionId?: string | null;
  chatLoading: boolean;
  chatHistoryPagination: ChatHistoryPagination;
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
  /** Monotonic count of locally owned runs cleared by terminal reconciliation. */
  chatRunLifecycleGeneration?: number;
  /** True when the active run was recovered from the embedded-run registry and
   * Stop must use the session-owned abort path (sessions.abort), not chat.abort. */
  chatRunSessionAbortable?: boolean;
  chatRunUsageById?: Map<string, RunOutputUsage>;
  /** Producer-cumulative text; visible tails derive from the segment baseline. */
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunStartup?: ChatRunStartupState | null;
  lastError: string | null;
  chatError?: string | null;
  chatRunError?: ChatRunError | null;
  lastLocalTerminalReconcile?: LocalTerminalReconcile | null;
  chatReplyTarget?: unknown;
  agentsError?: string | null;
  resetChatInputHistoryNavigation?: () => void;
  assistantAgentId?: string | null;
  agentsList?: ChatAgentsListSnapshot | null;
  agentsSelectedId?: string | null;
  hello: GatewayHelloOk | null;
  selfUser?: AuthenticatedUser | null;
  canvasPluginSurfaceUrl?: string | null;
  settings?: { chatPersistCommentary?: boolean; gatewayUrl?: string | null };
  sessions?: Partial<SessionCapability>;
  chatSessionMessageSubscriptionRequestedKey?: string | null;
  chatSessionMessageSubscription?: SessionMessageSubscription | null;
  chatSessionApprovalQueue?: ExecApprovalRequest[];
  chatBranches?: SessionBranch[];
  chatBranchesSessionKey?: string | null;
  chatBranchesConnectionEpoch?: number | null;
  requestUpdate?: () => void;
};
