import type { GatewayBrowserClient } from "../../api/gateway.ts";

type ChatRunWaitResult = {
  status?: unknown;
  endedAt?: unknown;
  error?: unknown;
  stopReason?: unknown;
  livenessState?: unknown;
  yielded?: unknown;
  pendingError?: unknown;
};

type ChatOutboxRunWaitProjection =
  | { yielded: true; outcome?: never; sessionStatus?: never }
  | {
      yielded?: false;
      outcome: "done" | "interrupted";
      sessionStatus: "done" | "failed" | "killed" | "timeout";
    };

type ChatOutboxRunWatch = {
  connectionEpoch: number | undefined;
  timer: ReturnType<typeof setTimeout>;
};

type ChatOutboxRunWatchOptions = {
  client: GatewayBrowserClient;
  connectionEpoch: number | undefined;
  delayMs?: number;
  isCurrent: () => boolean;
  onTerminal: (projection: ChatOutboxRunWaitProjection) => Promise<void>;
  runId: string;
};

const CHAT_OUTBOX_RUN_WATCH_IDLE_MS = 15_000;
const CHAT_OUTBOX_RUN_WATCH_RETRY_MS = 5_000;
const CHAT_OUTBOX_RUN_WATCH_WAIT_MS = 50;

const chatOutboxRunWatches = new WeakMap<GatewayBrowserClient, Map<string, ChatOutboxRunWatch>>();

function runWatchesFor(client: GatewayBrowserClient): Map<string, ChatOutboxRunWatch> {
  const existing = chatOutboxRunWatches.get(client);
  if (existing) {
    return existing;
  }
  const created = new Map<string, ChatOutboxRunWatch>();
  chatOutboxRunWatches.set(client, created);
  return created;
}

function isTerminalChatRunWait(result: ChatRunWaitResult | undefined): result is ChatRunWaitResult {
  if (!result) {
    return false;
  }
  const status = typeof result.status === "string" ? result.status.trim().toLowerCase() : "";
  if (status === "pending" || result.pendingError === true) {
    return false;
  }
  if (status === "ok" || status === "error") {
    return true;
  }
  if (status !== "timeout") {
    return false;
  }
  return (
    result.endedAt != null ||
    result.error != null ||
    result.stopReason != null ||
    result.livenessState != null ||
    result.yielded === true
  );
}

function projectTerminalChatRunWait(result: ChatRunWaitResult): ChatOutboxRunWaitProjection {
  const status = typeof result.status === "string" ? result.status.trim().toLowerCase() : "";
  const stopReason =
    typeof result.stopReason === "string" ? result.stopReason.trim().toLowerCase() : "";
  if (status === "ok" && result.yielded === true && stopReason === "end_turn") {
    return { yielded: true };
  }
  if (status === "ok") {
    return { outcome: "done", sessionStatus: "done" };
  }
  if (status === "timeout") {
    return { outcome: "interrupted", sessionStatus: "timeout" };
  }
  const cancelled =
    stopReason === "aborted" ||
    stopReason === "restart" ||
    stopReason === "superseded" ||
    stopReason === "rpc" ||
    stopReason === "stop";
  return {
    outcome: "interrupted",
    sessionStatus: cancelled ? "killed" : "failed",
  };
}

async function probeChatOutboxRun(options: ChatOutboxRunWatchOptions): Promise<void> {
  if (!options.isCurrent()) {
    return;
  }
  let result: ChatRunWaitResult | undefined;
  try {
    result = await options.client.request<ChatRunWaitResult>("agent.wait", {
      runId: options.runId,
      timeoutMs: CHAT_OUTBOX_RUN_WATCH_WAIT_MS,
    });
  } catch {
    // A reconnect or transient request failure must not discard the queued turn.
  }
  if (!options.isCurrent()) {
    return;
  }
  if (!isTerminalChatRunWait(result)) {
    scheduleChatOutboxRunWatch({ ...options, delayMs: CHAT_OUTBOX_RUN_WATCH_RETRY_MS });
    return;
  }
  await options.onTerminal(projectTerminalChatRunWait(result));
}

export function scheduleChatOutboxRunWatch(options: ChatOutboxRunWatchOptions): void {
  const watches = runWatchesFor(options.client);
  const existing = watches.get(options.runId);
  if (existing && existing.connectionEpoch === options.connectionEpoch) {
    return;
  }
  if (existing) {
    // Logical reconnects can retain the browser client. Replace the stale
    // epoch's timer so durable resume cannot permanently disarm recovery.
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    watches.delete(options.runId);
    void probeChatOutboxRun(options);
  }, options.delayMs ?? CHAT_OUTBOX_RUN_WATCH_IDLE_MS);
  watches.set(options.runId, { connectionEpoch: options.connectionEpoch, timer });
}
