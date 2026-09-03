import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { visibleChatHistoryMessages } from "../../../lib/chat/message-visibility.ts";
import type { UiSessionDefaultsHost } from "../../../lib/sessions/session-key.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { CHAT_HISTORY_REQUEST_LIMIT } from "../chat-history-request.ts";
import type { ChatHistoryResult } from "../chat-history-snapshot.ts";

const TASK_TRANSCRIPT_REFRESH_MS = 2_000;

type TaskTranscriptLoad =
  | { status: "loading" }
  | { status: "loaded"; messages: unknown[] }
  | { status: "error" };

type TaskDetailState = {
  client: GatewayBrowserClient;
  connectionEpoch: number | undefined;
  eventVersion: number;
  inFlight: boolean;
  lastRequestStartedAt: number;
  load: TaskTranscriptLoad;
  refreshTimer: number | null;
  requestId: number;
  sessionKey: string;
  taskId: string;
};

export type TaskDetailHost = UiSessionDefaultsHost & {
  sessionKey: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch?: number;
  requestUpdate?: () => void;
  sessionsResultAgentId?: string | null;
  taskDetailState?: TaskDetailState;
};

function clearRefreshTimer(state: TaskDetailState) {
  if (state.refreshTimer !== null) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
}

export function resetTaskDetail(host: TaskDetailHost) {
  const current = host.taskDetailState;
  if (!current) {
    return;
  }
  clearRefreshTimer(current);
  host.taskDetailState = undefined;
}

function scheduleTranscriptLoad(host: TaskDetailHost, state: TaskDetailState) {
  if (host.taskDetailState !== state || state.inFlight) {
    return;
  }
  const remaining = TASK_TRANSCRIPT_REFRESH_MS - (Date.now() - state.lastRequestStartedAt);
  if (remaining > 0) {
    if (state.refreshTimer === null) {
      state.refreshTimer = window.setTimeout(() => {
        state.refreshTimer = null;
        scheduleTranscriptLoad(host, state);
      }, remaining);
    }
    return;
  }
  clearRefreshTimer(state);
  const client = host.client;
  if (
    !client ||
    !host.connected ||
    client !== state.client ||
    host.connectionEpoch !== state.connectionEpoch
  ) {
    state.load = { status: "error" };
    host.requestUpdate?.();
    return;
  }
  const requestId = ++state.requestId;
  const eventVersion = state.eventVersion;
  state.inFlight = true;
  state.lastRequestStartedAt = Date.now();
  if (state.load.status !== "loaded") {
    state.load = { status: "loading" };
  }
  host.requestUpdate?.();
  void (async () => {
    let load: TaskTranscriptLoad;
    try {
      const result = await client.request<ChatHistoryResult>("chat.history", {
        sessionKey: state.sessionKey,
        limit: CHAT_HISTORY_REQUEST_LIMIT,
      });
      load = { status: "loaded", messages: visibleChatHistoryMessages(result.messages) };
    } catch {
      load = { status: "error" };
    }
    const current = host.taskDetailState;
    if (
      current !== state ||
      current.requestId !== requestId ||
      host.client !== client ||
      host.connectionEpoch !== state.connectionEpoch
    ) {
      return;
    }
    state.inFlight = false;
    state.load = load;
    host.requestUpdate?.();
    // Events that arrived during this request own a later snapshot. This also
    // guarantees one final history read after a terminal transition.
    if (state.eventVersion > eventVersion) {
      scheduleTranscriptLoad(host, state);
    }
  })();
}

export function readTaskTranscript(
  host: TaskDetailHost,
  selection: { taskId: string; sessionKey: string },
): TaskTranscriptLoad {
  const client = host.client;
  const current = host.taskDetailState;
  if (
    current &&
    current.taskId === selection.taskId &&
    current.sessionKey === selection.sessionKey &&
    current.client === client &&
    current.connectionEpoch === host.connectionEpoch
  ) {
    return current.load;
  }
  resetTaskDetail(host);
  if (!client || !host.connected) {
    return { status: "error" };
  }
  const next: TaskDetailState = {
    client,
    connectionEpoch: host.connectionEpoch,
    eventVersion: 0,
    inFlight: false,
    lastRequestStartedAt: Number.NEGATIVE_INFINITY,
    load: { status: "loading" },
    refreshTimer: null,
    requestId: 0,
    sessionKey: selection.sessionKey,
    taskId: selection.taskId,
  };
  host.taskDetailState = next;
  scheduleTranscriptLoad(host, next);
  return next.load;
}

export function observeTaskDetailEvent(
  host: TaskDetailHost,
  event:
    | { action: "upserted"; task: TaskSummary }
    | { action: "deleted"; taskId: string }
    | { action: "restored" },
) {
  const state = host.taskDetailState;
  if (!state) {
    return;
  }
  if (event.action === "deleted") {
    if (event.taskId === state.taskId) {
      resetTaskDetail(host);
    }
    return;
  }
  if (event.action !== "upserted" || event.task.id !== state.taskId) {
    return;
  }
  state.eventVersion += 1;
  // A terminal version remains pending through an in-flight or throttled read,
  // so the next request is always the final task-session snapshot.
  scheduleTranscriptLoad(host, state);
}
