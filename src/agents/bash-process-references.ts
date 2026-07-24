/**
 * Compact references for active background bash sessions.
 * These references are surfaced in agent context so follow-up turns can
 * reconnect to prior long-running work.
 */
import { truncateUtf16Safe } from "../utils.js";
import { listRunningSessions } from "./bash-process-registry.js";
import {
  deriveRedactedProcessSessionName,
  redactProcessSessionText,
} from "./bash-tools.process-redaction.js";

const DEFAULT_ACTIVE_PROCESS_LIMIT = 8;
const MAX_COMMAND_LABEL_CHARS = 140;

/** Agent-facing summary of a reconnectable background process session. */
export type ActiveProcessSessionReference = {
  sessionId: string;
  status: "running";
  pid?: number;
  startedAt: number;
  runtimeMs: number;
  cwd?: string;
  command: string;
  name: string;
  tail?: string;
  truncated: boolean;
  redacted?: true;
};

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return truncateUtf16Safe(value, maxChars);
  }
  return `${truncateUtf16Safe(value, Math.max(0, maxChars - 3))}...`;
}

/** List active background process sessions for one scope key, newest first. */
export function listActiveProcessSessionReferences(params: {
  scopeKey?: string;
  now?: number;
  limit?: number;
}): ActiveProcessSessionReference[] {
  const scopeKey = params.scopeKey?.trim();
  if (!scopeKey) {
    return [];
  }
  const now = params.now ?? Date.now();
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
      ? Math.floor(params.limit)
      : DEFAULT_ACTIVE_PROCESS_LIMIT;
  return listRunningSessions()
    .filter((session) => session.backgrounded)
    .filter((session) => session.scopeKey === scopeKey)
    .toSorted((left, right) => right.startedAt - left.startedAt)
    .slice(0, limit)
    .map((session) => {
      const command = redactProcessSessionText(session.command);
      const name = truncate(
        deriveRedactedProcessSessionName(session.command) ?? command,
        MAX_COMMAND_LABEL_CHARS,
      );
      const tail = redactProcessSessionText(session.tail);
      const redacted = command !== session.command || tail !== session.tail;
      const reference: ActiveProcessSessionReference = {
        sessionId: session.id,
        status: "running" as const,
        pid: session.pid ?? session.child?.pid,
        startedAt: session.startedAt,
        runtimeMs: Math.max(0, now - session.startedAt),
        cwd: session.cwd,
        command,
        name,
        tail,
        truncated: session.truncated,
      };
      if (redacted) {
        reference.redacted = true;
      }
      return reference;
    });
}
