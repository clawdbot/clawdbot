// Defines the TUI backend contract and backend event shapes.
import type {
  CommandEntry,
  CommandsListParams,
  SessionsListParams,
  SessionsPatchParams,
  SessionsPatchResult,
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
      | "goal"
      | "modelProvider"
      | "displayName"
    > & {
      key: string;
      sessionId?: string;
      updatedAt?: number | null;
      fastMode?: boolean;
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
  sendChat: (opts: ChatSendOptions) => Promise<{ runId: string }>;
  abortChat: (opts: {
    sessionKey: string;
    agentId?: string;
    runId: string;
  }) => Promise<{ ok: boolean; aborted: boolean }>;
  loadHistory: (opts: { sessionKey: string; agentId?: string; limit?: number }) => Promise<unknown>;
  listSessions: (opts?: SessionsListParams) => Promise<TuiSessionList>;
  listAgents: () => Promise<TuiAgentsList>;
  patchSession: (opts: SessionsPatchParams) => Promise<SessionsPatchResult>;
  resetSession: (
    key: string,
    reason?: "new" | "reset",
    opts?: { agentId?: string },
  ) => Promise<TuiSessionMutationResult>;
  getGatewayStatus: () => Promise<unknown>;
  listModels: () => Promise<TuiModelChoice[]>;
  listCommands?: (opts?: CommandsListParams) => Promise<CommandEntry[]>;
  runGoalCommand?: (opts: TuiGoalCommandOptions) => Promise<{ text: string }>;
};
