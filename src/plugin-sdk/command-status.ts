/**
 * Public SDK subpath for command and help status message rendering.
 */
export {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
} from "../auto-reply/command-status-builders.js";
export type {
  CommandsMessageOptions,
  CommandsMessageResult,
} from "../auto-reply/command-status-builders.js";
// SDK-owned status projections (#76759). The full /status payload is a
// host-owned aggregate whose nested shapes keep evolving, so it is not part of
// the public SDK; plugins bind these bounded projections instead. Host rows
// must stay assignable to them — command-status.types.test.ts breaks loudly
// on a projected-field rename.

/** One /status session row as visible to plugins: identity plus token usage. */
export type StatusSessionRow = {
  agentId?: string;
  key: string;
  sessionId?: string;
  updatedAt: number | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number | null;
  remainingTokens: number | null;
  percentUsed: number | null;
  contextTokens: number | null;
  model: string | null;
  flags: string[];
};

/** Per-agent heartbeat schedule state as visible to plugins. */
export type StatusHeartbeat = {
  agentId: string;
  enabled: boolean;
  every: string;
  everyMs: number | null;
};

/** Session portion of a /status payload as visible to plugins. */
export type StatusSessionsProjection = {
  count: number;
  recent: StatusSessionRow[];
  byAgent: Array<{ agentId: string; count: number; recent: StatusSessionRow[] }>;
};
