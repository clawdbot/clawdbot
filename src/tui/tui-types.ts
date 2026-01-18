export type TuiOptions = {
  url?: string;
  token?: string;
  password?: string;
  session?: string;
  deliver?: boolean;
  thinking?: string;
  timeoutMs?: number;
  historyLimit?: number;
  message?: string;
};

export type ChatEvent = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export type AgentEvent = {
  runId: string;
  stream: string;
  data?: Record<string, unknown>;
};

export type SessionInfo = {
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  model?: string;
  modelProvider?: string;
  contextTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  responseUsage?: "on" | "off" | "tokens" | "full";
  updatedAt?: number | null;
  displayName?: string;
};

export type SessionScope = "per-sender" | "global";

export type AgentSummary = {
  id: string;
  name?: string;
};

export type GatewayStatusSummary = {
  linkChannel?: {
    id?: string;
    label?: string;
    linked?: boolean;
    authAgeMs?: number | null;
  };
  heartbeat?: {
    defaultAgentId?: string;
    agents?: Array<{
      agentId?: string;
      enabled?: boolean;
      every?: string;
      everyMs?: number | null;
    }>;
  };
  providerSummary?: string[];
  queuedSystemEvents?: string[];
  sessions?: {
    paths?: string[];
    count?: number;
    defaults?: { model?: string | null; contextTokens?: number | null };
    recent?: Array<{
      agentId?: string;
      key: string;
      kind?: string;
      updatedAt?: number | null;
      age?: number | null;
      model?: string | null;
      totalTokens?: number | null;
      contextTokens?: number | null;
      remainingTokens?: number | null;
      percentUsed?: number | null;
      flags?: string[];
    }>;
  };
};

export type TuiStateAccess = {
  agentDefaultId: string;
  sessionMainKey: string;
  sessionScope: SessionScope;
  agents: AgentSummary[];
  currentAgentId: string;
  currentSessionKey: string;
  currentSessionId: string | null;
  activeChatRunId: string | null;
  historyLoaded: boolean;
  sessionInfo: SessionInfo;
  initialSessionApplied: boolean;
  isConnected: boolean;
  autoMessageSent: boolean;
  toolsExpanded: boolean;
  showThinking: boolean;
  connectionStatus: string;
  activityStatus: string;
  statusTimeout: ReturnType<typeof setTimeout> | null;
  lastCtrlCAt: number;
};
