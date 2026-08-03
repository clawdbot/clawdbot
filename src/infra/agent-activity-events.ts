import { emitAgentEvent, type AgentApprovalEventData } from "./agent-events.js";

/** Lifecycle phase for a visible item in the agent activity feed. */
type AgentItemEventPhase = "start" | "update" | "end";
/** Status rendered for an item-level agent activity event. */
type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";
/** Item category used by channels and Control UI to choose progress presentation. */
type AgentItemEventKind = "tool" | "command" | "patch" | "search" | "analysis" | (string & {});

/** Payload for a single item shown in the agent activity stream. */
export type AgentItemEventData = {
  itemId: string;
  phase: AgentItemEventPhase;
  kind: AgentItemEventKind;
  title: string;
  status: AgentItemEventStatus;
  name?: string;
  meta?: string;
  toolCallId?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  summary?: string;
  progressText?: string;
  /** Preserve item telemetry while letting channel progress render a sibling tool event instead. */
  suppressChannelProgress?: boolean;
  /** Preserve activity telemetry without rendering this internal item in channel progress. */
  hideFromChannelProgress?: boolean;
  approvalId?: string;
  approvalSlug?: string;
};

/** Incremental command output payload associated with an item/tool call. */
export type AgentCommandOutputEventData = {
  itemId: string;
  phase: "delta" | "end";
  title: string;
  toolCallId: string;
  name?: string;
  output?: string;
  status?: AgentItemEventStatus | "running";
  exitCode?: number | null;
  durationMs?: number;
  cwd?: string;
};

/** Patch summary payload emitted after an agent applies file changes. */
export type AgentPatchSummaryEventData = {
  itemId: string;
  phase: "end";
  title: string;
  toolCallId: string;
  name?: string;
  added: string[];
  modified: string[];
  deleted: string[];
  summary: string;
};

/** Emits an item activity event on the shared agent event bus. */
export function emitAgentItemEvent(params: {
  runId: string;
  data: AgentItemEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "item",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

/** Emits an approval event on the shared agent event bus. */
export function emitAgentApprovalEvent(params: {
  runId: string;
  data: AgentApprovalEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "approval",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

/** Emits command output for a running or completed item/tool call. */
export function emitAgentCommandOutputEvent(params: {
  runId: string;
  data: AgentCommandOutputEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "command_output",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

/** Emits a patch summary for a completed file-editing item/tool call. */
export function emitAgentPatchSummaryEvent(params: {
  runId: string;
  data: AgentPatchSummaryEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "patch",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}
