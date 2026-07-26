import type { FastMode } from "@openclaw/normalization-core/string-coerce";
// Defines shared TUI state, backend, and event types.
import type { SessionGoal } from "../config/sessions/types.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import type { TuiPendingSubmit } from "./tui-submit-state.js";

export type TuiOptions = {
  local?: boolean;
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  session?: string;
  deliver?: boolean;
  thinking?: string;
  timeoutMs?: number;
  historyLimit?: number;
  message?: string;
  /**
   * Internal CLI guard: after the standalone TUI returns, force the child
   * process out if imported runtime handles keep the event loop alive.
   */
  forceProcessExitOnReturn?: boolean;
};

type TuiExitReason = "exit" | "return-to-system-agent";

export type TuiResult = {
  exitReason: TuiExitReason;
  systemAgentMessage?: string;
};

export type TuiHistoryLoadResult =
  | { loaded: true; inFlightRunId: string | null }
  | { loaded: false };

export type ChatEvent = {
  runId: string;
  sessionKey: string;
  agentId?: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export type BtwEvent = {
  kind: "btw";
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  question: string;
  text: string;
  isError?: boolean;
  seq?: number;
  ts?: number;
};

export type SessionChangedEvent = {
  sessionKey?: string;
  agentId?: string;
  reason?: string;
  phase?: string;
  runId?: string;
  sessionId?: string;
  updatedAt?: number | null;
};

export type AgentEvent = {
  runId: string;
  stream: string;
  data?: Record<string, unknown>;
  // Stamped by the gateway on every emitted payload (see infra/agent-events.ts).
  // Lifecycle events always carry sessionKey, letting the TUI adopt
  // system-injected runs that never went through the local submit path.
  sessionKey?: string;
  agentId?: string;
};

export type ResponseUsageMode = "on" | "off" | "tokens" | "full";

export type SessionInfo = {
  thinkingLevel?: string;
  thinkingLevels?: Array<{ id: string; label: string }>;
  fastMode?: FastMode;
  verboseLevel?: string;
  traceLevel?: string;
  reasoningLevel?: string;
  model?: string;
  modelProvider?: string;
  agentRuntime?: GatewayAgentRuntime;
  contextTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /**
   * True when `totalTokens` is a known-fresh value (e.g. 0 on a brand-new
   * session) rather than an unknown/stale total. Lets the footer render `0`
   * instead of `?` for fresh sessions, mirroring the `/status` fix in #93798.
   */
  totalTokensFresh?: boolean;
  goal?: SessionGoal;
  responseUsage?: ResponseUsageMode;
  /** Resolved effective usage mode (session override → channel config → default → off). Set by the gateway; the TUI uses this for no-arg toggle cycles so the cycle starts from the effective visible mode rather than the raw session value. */
  effectiveResponseUsage?: ResponseUsageMode;
  updatedAt?: number | null;
  displayName?: string;
};

export type SessionScope = "per-sender" | "global";

export type AgentSummary = {
  id: string;
  kind?: "agent" | "system";
  name?: string;
};

type QueuedMessageMode = "steer" | "followUp";

type QueuedMessage = {
  runId: string;
  text: string;
  mode: QueuedMessageMode;
};

export type GatewayStatusSummary = {
  runtimeVersion?: string | null;
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
  pendingSubmit: TuiPendingSubmit | null;
  queuedMessages?: QueuedMessage[];
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
