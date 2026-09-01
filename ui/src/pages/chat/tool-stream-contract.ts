// Leaf contract for the tool-stream lane: the host-state shape and event
// payload types shared by tool-stream, its status/preamble modules, and the
// chat state owners. Keep this module import-light so the lane stays acyclic.
import type { ChatGuardianNotice, ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import type { DiffStat } from "../../lib/chat/tool-call-diff.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type { UiSessionDefaultsHost } from "../../lib/sessions/session-key.ts";
import type { ChatRunStartupState } from "./chat-run-startup.ts";

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  agentId?: string;
  data: Record<string, unknown>;
};

export type ToolStreamEntry = {
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  name: string;
  args?: unknown;
  output?: string;
  /** Structured result details (e.g. edit diff) captured from the result event. */
  details?: unknown;
  /** Monotonic edit counts received while the tool arguments stream. */
  liveDiffStat?: DiffStat;
  isError?: boolean;
  exitCode?: number;
  /** True once a result event landed, even when the output text is empty. */
  resultReceived?: boolean;
  startedAt: number;
  receivedAt: number;
  message: Record<string, unknown>;
};

export type RunOutputUsage = { outputTokens: number; seq: number };

export type CompactionStatus = {
  phase: "active" | "retrying" | "complete";
  runId: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

export type WaitingApprovalStatus = {
  approvalId: string;
  toolCallId: string | null;
  runId: string;
};

export type ToolStreamHost = {
  sessionKey: string;
  assistantAgentId?: string | null;
  agentsList?: UiSessionDefaultsHost["agentsList"];
  hello?: { snapshot?: unknown } | null;
  chatRunId: string | null;
  chatMessages?: unknown[];
  chatRunUsageById?: Map<string, RunOutputUsage>;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunStartup?: ChatRunStartupState | null;
  chatStreamSegments: ChatStreamSegment[];
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  activityEventSeqById?: Map<string, number>;
  chatToolMessages: Record<string, unknown>[];
  guardianNotices?: ChatGuardianNotice[];
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
  toolStreamSyncTimer: number | null;
  knownAgentRunIds?: Set<string>;
  waitingApprovalStatuses?: Map<string, WaitingApprovalStatus>;
  waitingApprovalResolvedIds?: Set<string>;
  requestUpdate?: () => void;
  sessions: Pick<SessionCapability, "refreshReplacement">;
};
