import type { FastMode } from "@openclaw/normalization-core/string-coerce";
// Defines the TUI backend contract and backend event shapes.
import type {
  CommandEntry,
  CommandsListParams,
  SessionsListParams,
  SessionsPatchParams,
  SessionsPatchResult,
  TaskSuggestion,
  TaskSuggestionsAcceptResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { ResponseUsageMode, SessionInfo, SessionScope } from "./tui-types.js";

// Transport-agnostic backend contract consumed by the TUI runtime.
/** Options for sending one chat turn through a TUI backend. */
export type ChatSendOptions = {
  sessionKey: string;
  agentId?: string;
  sessionId?: string | null;
  message: string;
  thinking?: string;
  deliver?: boolean;
  timeoutMs?: number;
  runId?: string;
};

export type TuiChatSendResult = {
  runId: string;
  status?: string;
};

export type TuiApprovalDecision = "allow-once" | "allow-always" | "deny";

export type TuiTaskSuggestionActionCapabilities = {
  canAccept: boolean;
  canDismiss: boolean;
};

export type TuiPluginApproval = {
  id: string;
  request: {
    title: string;
    description?: string | null;
    pluginId?: string | null;
    severity?: "info" | "warning" | "critical" | null;
    toolName?: string | null;
    allowedDecisions?: readonly TuiApprovalDecision[] | null;
    agentId?: string | null;
    sessionKey?: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
};

/** Options for forwarding a goal command to a backend session. */
export type TuiGoalCommandOptions = {
  sessionKey: string;
  agentId?: string;
  command: string;
};

/** Event envelope delivered from Gateway or the embedded backend into the TUI. */
export type TuiEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
};

/** Session-list payload rendered by session pickers and status surfaces. */
export type TuiSessionList = {
  ts: number;
  path: string;
  count: number;
  totalCount?: number;
  limitApplied?: number;
  hasMore?: boolean;
  defaults?: {
    model?: string | null;
    modelProvider?: string | null;
    contextTokens?: number | null;
    thinkingLevels?: Array<{ id: string; label: string }>;
  };
  sessions: Array<
    Pick<
      SessionInfo,
      | "thinkingLevel"
      | "thinkingLevels"
      | "fastMode"
      | "verboseLevel"
      | "reasoningLevel"
      | "model"
      | "contextTokens"
      | "inputTokens"
      | "outputTokens"
      | "totalTokens"
      | "totalTokensFresh"
      | "goal"
      | "modelProvider"
      | "displayName"
    > & {
      key: string;
      sessionId?: string;
      updatedAt?: number | null;
      fastMode?: FastMode;
      sendPolicy?: string;
      responseUsage?: ResponseUsageMode;
      label?: string;
      provider?: string;
      groupChannel?: string;
      space?: string;
      subject?: string;
      chatType?: string;
      origin?: {
        label?: string;
        provider?: string;
        surface?: string;
      };
      lastChannel?: string;
      lastProvider?: string;
      lastTo?: string;
      lastAccountId?: string;
      derivedTitle?: string;
      lastMessagePreview?: string;
    }
  >;
};

/** Agent-list payload used by TUI agent switching. */
export type TuiAgentsList = {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: Array<{
    id: string;
    name?: string;
  }>;
};

/** Model choice payload shown by TUI model pickers. */
export type TuiModelChoice = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

/** Result shape returned by session mutation commands. */
export type TuiSessionMutationResult = {
  ok?: boolean;
  key?: string;
  entry?: Partial<SessionInfo> & {
    sessionId?: string;
    updatedAt?: number | null;
  };
  resolved?: {
    modelProvider?: string;
    model?: string;
  };
};

/** Options for creating a fresh TUI session through the backend lifecycle. */
export type TuiSessionCreateOptions = {
  key: string;
  agentId?: string;
  parentSessionKey?: string;
};

/** Minimal backend interface shared by Gateway and embedded local TUI modes. */
export type TuiBackend = {
  connection: {
    url: string;
    token?: string;
    password?: string;
  };
  onEvent?: (evt: TuiEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  start: () => void;
  stop: () => void | Promise<void>;
  subscribeSessionEvents?: () => Promise<unknown>;
  sendChat: (opts: ChatSendOptions) => Promise<TuiChatSendResult>;
  /** runId optional: omit for session-scoped abort (queued turns then active). */
  abortChat: (opts: {
    sessionKey: string;
    agentId?: string;
    runId?: string;
  }) => Promise<{ ok: boolean; aborted: boolean; runIds?: string[] }>;
  loadHistory: (opts: { sessionKey: string; agentId?: string; limit?: number }) => Promise<unknown>;
  listSessions: (opts?: SessionsListParams) => Promise<TuiSessionList>;
  listAgents: () => Promise<TuiAgentsList>;
  patchSession: (opts: SessionsPatchParams) => Promise<SessionsPatchResult>;
  createSession: (opts: TuiSessionCreateOptions) => Promise<TuiSessionMutationResult>;
  resetSession: (
    key: string,
    reason?: "new" | "reset",
    opts?: { agentId?: string },
  ) => Promise<TuiSessionMutationResult>;
  getGatewayStatus: () => Promise<unknown>;
  listModels: () => Promise<TuiModelChoice[]>;
  listCommands?: (opts?: CommandsListParams) => Promise<CommandEntry[]>;
  listPluginApprovals?: () => Promise<unknown>;
  resolvePluginApproval?: (id: string, decision: TuiApprovalDecision) => Promise<{ ok?: boolean }>;
  getTaskSuggestionActionCapabilities?: () => TuiTaskSuggestionActionCapabilities;
  listTaskSuggestions?: () => Promise<TaskSuggestion[]>;
  acceptTaskSuggestion?: (taskId: string) => Promise<TaskSuggestionsAcceptResult>;
  dismissTaskSuggestion?: (taskId: string) => Promise<{ taskId: string; dismissed: boolean }>;
  runGoalCommand?: (opts: TuiGoalCommandOptions) => Promise<{ text: string }>;
};
