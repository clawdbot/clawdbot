import { emitAgentEvent, type AgentApprovalEventData } from "./agent-events.js";

/** Lifecycle phase for a visible item in the agent activity feed. */
type AgentItemEventPhase = "start" | "update" | "end";
/** Status rendered for an item-level agent activity event. */
type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";
/** Item category used by channels and Control UI to choose progress presentation. */
type AgentItemEventKind = "tool" | "command" | "patch" | "search" | "analysis" | (string & {});

/** Payload for a single item shown in the agent activity stream. */
export type AgentItemEventData = Record<string, unknown> & {
  itemId: string;
  phase: AgentItemEventPhase;
  kind: AgentItemEventKind;
  title: string;
  status: AgentItemEventStatus;
  name?: string;
  meta?: string;
  commandBearing?: boolean;
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
export type AgentCommandOutputEventData = Record<string, unknown> & {
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
export type AgentPatchSummaryEventData = Record<string, unknown> & {
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

type AgentActivityEventDataByStream = {
  item: AgentItemEventData;
  approval: AgentApprovalEventData & Record<string, unknown>;
  command_output: AgentCommandOutputEventData;
  patch: AgentPatchSummaryEventData;
};

type AgentActivityEventParams = {
  [Stream in keyof AgentActivityEventDataByStream]: {
    runId: string;
    sessionKey?: string;
    stream: Stream;
    data: AgentActivityEventDataByStream[Stream];
  };
}[keyof AgentActivityEventDataByStream];

/** Emits a typed activity event on the shared agent event bus. */
export function emitAgentActivityEvent(params: AgentActivityEventParams): void {
  emitAgentEvent({
    runId: params.runId,
    stream: params.stream,
    data: params.data,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}
