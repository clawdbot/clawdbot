import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { listRunningSessions } from "./bash-process-registry.js";
import { deriveSessionName } from "./bash-tools.shared.js";

const DEFAULT_ACTIVE_PROCESS_LIMIT = 8;
const MAX_COMMAND_LABEL_CHARS = 140;

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
};

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

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
    .map((session) => ({
      sessionId: session.id,
      status: "running" as const,
      pid: session.pid ?? session.child?.pid,
      startedAt: session.startedAt,
      runtimeMs: Math.max(0, now - session.startedAt),
      cwd: session.cwd,
      command: session.command,
      name: truncate(
        deriveSessionName(session.command) || session.command,
        MAX_COMMAND_LABEL_CHARS,
      ),
      tail: session.tail,
      truncated: session.truncated,
    }));
}

export function formatActiveProcessSessionReference(
  session: ActiveProcessSessionReference,
): string {
  const runtime = formatDurationCompact(session.runtimeMs) ?? "unknown";
  const pid = typeof session.pid === "number" ? ` pid=${session.pid}` : "";
  const cwd = session.cwd ? ` cwd=${session.cwd}` : "";
  return `${session.sessionId} ${session.status} ${runtime}${pid}${cwd} :: ${session.name}`;
}
