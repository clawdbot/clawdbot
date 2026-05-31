import { log } from "../logger.js";

export type EmbeddedAgentActiveSessionSteerTarget = {
  agent?: unknown;
  getSteeringMessages?(): readonly string[];
  steer(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
};

export const DEFAULT_QUEUE_TRANSCRIPT_COMMIT_TIMEOUT_MS = 120_000;

function extractQueuedUserMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as { content?: unknown; role?: unknown };
  if (record.role !== "user") {
    return undefined;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const text = record.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return undefined;
      }
      const typedBlock = block as { text?: unknown; type?: unknown };
      return typedBlock.type === "text" && typeof typedBlock.text === "string"
        ? typedBlock.text
        : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .join("");
  return text || undefined;
}

function isQueuedUserMessageEnd(event: unknown, text: string): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  const record = event as { message?: unknown; type?: unknown };
  return record.type === "message_end" && extractQueuedUserMessageText(record.message) === text;
}

function isTerminalActiveSessionEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "agent_end",
  );
}

function isAutoRetryStartEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "auto_retry_start",
  );
}

function isCompactionStartEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "compaction_start",
  );
}

function getAgentSteeringQueueMessages(agent: unknown): unknown[] | undefined {
  if (!agent || typeof agent !== "object") {
    return undefined;
  }
  const queue = (agent as { steeringQueue?: unknown }).steeringQueue;
  if (!queue || typeof queue !== "object") {
    return undefined;
  }
  const messages = (queue as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : undefined;
}

export async function cancelQueuedSteeringMessage(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
): Promise<boolean> {
  const queuedMessages = getAgentSteeringQueueMessages(activeSession.agent);
  if (!queuedMessages) {
    return false;
  }
  // The session runtime exposes only all-queue clears publicly; mutate the exact pending message
  // so unrelated queued messages keep their full payloads.
  const queueIndex = queuedMessages.findIndex(
    (message) => extractQueuedUserMessageText(message) === text,
  );
  if (queueIndex === -1) {
    return false;
  }
  queuedMessages.splice(queueIndex, 1);
  const uiSteeringMessages = activeSession.getSteeringMessages?.();
  if (Array.isArray(uiSteeringMessages)) {
    const uiIndex = uiSteeringMessages.indexOf(text);
    if (uiIndex !== -1) {
      uiSteeringMessages.splice(uiIndex, 1);
    }
  }
  return true;
}

export async function steerAndWaitForTranscriptCommit(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (terminalTimer) {
        clearTimeout(terminalTimer);
      }
      unsubscribe?.();
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };
    const rejectAfterCancellation = (message: string) => {
      void cancelQueuedSteeringMessage(activeSession, text)
        .then((removed) => {
          if (!removed) {
            log.warn("failed to find queued steering message for cancellation");
          }
        })
        .catch((err: unknown) => {
          log.warn(`failed to cancel queued steering message: ${String(err)}`);
        })
        .finally(() => {
          finish(new Error(message));
        });
    };
    const scheduleTerminalCancellation = () => {
      if (terminalTimer) {
        return;
      }
      terminalTimer = setTimeout(() => {
        terminalTimer = undefined;
        rejectAfterCancellation(
          "active session ended before queued steering message was committed to the transcript",
        );
      }, 0);
      terminalTimer.unref?.();
    };
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        rejectAfterCancellation(
          "queued steering message was not committed to the transcript before timeout",
        );
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    const unsubscribe: (() => void) | undefined = activeSession.subscribe((event) => {
      if (isAutoRetryStartEvent(event) || isCompactionStartEvent(event)) {
        if (terminalTimer) {
          clearTimeout(terminalTimer);
          terminalTimer = undefined;
        }
        return;
      }
      if (isQueuedUserMessageEnd(event, text)) {
        finish();
        return;
      }
      if (isTerminalActiveSessionEvent(event)) {
        // AgentSession emits agent_end before announcing auto-retry or
        // auto-compaction continuations. Defer cancellation one tick so those
        // continuation events can keep draining this message.
        scheduleTerminalCancellation();
      }
    });
    activeSession.steer(text).catch((err: unknown) => {
      finish(err);
    });
  });
}

export async function steerActiveSessionWithOptionalDeliveryWait(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  options: { deliveryTimeoutMs?: number; waitForTranscriptCommit?: boolean } | undefined,
): Promise<void> {
  if (options?.waitForTranscriptCommit !== true) {
    await activeSession.steer(text);
    return;
  }
  await steerAndWaitForTranscriptCommit(
    activeSession,
    text,
    options.deliveryTimeoutMs ?? DEFAULT_QUEUE_TRANSCRIPT_COMMIT_TIMEOUT_MS,
  );
}
