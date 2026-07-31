import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import type { NodeHostClient } from "./client.js";
import type { NodeInvokeRequestPayload } from "./invoke-types.js";

const PROGRESS_CHUNK_BYTES = 16 * 1024;
const MIN_HEARTBEAT_INTERVAL_MS = 250;
const MAX_HEARTBEAT_INTERVAL_MS = 5_000;

type Pausable = { pause(): void; resume(): void };

function resolveNodeInvokeHeartbeatInterval(idleTimeoutMs: number): number {
  return Math.max(
    MIN_HEARTBEAT_INTERVAL_MS,
    Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.floor(idleTimeoutMs / 2)),
  );
}

export function createNodeInvokeProgressWriter(params: {
  client: NodeHostClient;
  frame: NodeInvokeRequestPayload;
  idleTimeoutMs: number;
  onError: (error: Error) => void;
}) {
  let seq = 0;
  let queue = Promise.resolve();
  let progressError: Error | undefined;
  let heartbeatQueued = false;
  let heartbeatDirty = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let recurringHeartbeats = false;
  let stopped = false;
  let lastProgressAt = 0;
  const heartbeatIntervalMs = resolveNodeInvokeHeartbeatInterval(params.idleTimeoutMs);

  const recordError = (error: unknown) => {
    progressError = error instanceof Error ? error : new Error(String(error));
    params.onError(progressError);
  };

  const enqueue = (task: () => Promise<void>, pausable?: Pausable): Promise<void> => {
    pausable?.pause();
    queue = queue
      .then(task)
      .catch(recordError)
      .finally(() => pausable?.resume());
    return queue;
  };

  const sendText = async (text: string) => {
    let remaining = text;
    while (remaining) {
      const chunk = truncateUtf8Prefix(remaining, PROGRESS_CHUNK_BYTES);
      if (!chunk) {
        break;
      }
      await params.client.request("node.invoke.progress", {
        invokeId: params.frame.id,
        nodeId: params.frame.nodeId,
        seq,
        chunk,
      });
      seq += 1;
      remaining = remaining.slice(chunk.length);
    }
  };

  const queueHeartbeat = () => {
    if (stopped) {
      return;
    }
    if (heartbeatQueued) {
      heartbeatDirty = true;
      return;
    }
    heartbeatQueued = true;
    const delayMs = Math.max(0, heartbeatIntervalMs - (Date.now() - lastProgressAt));
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      void enqueue(async () => {
        await params.client.request("node.invoke.progress", {
          invokeId: params.frame.id,
          nodeId: params.frame.nodeId,
          seq,
          chunk: "",
        });
        seq += 1;
        lastProgressAt = Date.now();
      }).finally(() => {
        heartbeatQueued = false;
        if ((heartbeatDirty || recurringHeartbeats) && !stopped) {
          heartbeatDirty = false;
          queueHeartbeat();
        }
      });
    }, delayMs);
  };

  return {
    write(text: string, pausable?: Pausable): Promise<void> {
      if (!text || stopped) {
        return queue;
      }
      lastProgressAt = Date.now();
      return enqueue(() => sendText(text), pausable);
    },
    queueHeartbeat,
    startHeartbeats(): void {
      recurringHeartbeats = true;
      queueHeartbeat();
    },
    stopHeartbeats(): void {
      recurringHeartbeats = false;
      heartbeatDirty = false;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      heartbeatQueued = false;
    },
    async flush(): Promise<void> {
      await queue.catch(() => {});
    },
    stop(): void {
      stopped = true;
      recurringHeartbeats = false;
      heartbeatDirty = false;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    },
    get error(): Error | undefined {
      return progressError;
    },
  };
}
