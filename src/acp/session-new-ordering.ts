import type { AnyMessage } from "@agentclientprotocol/sdk";

type JsonObject = Record<string, unknown>;

/** Keeps initial session updates behind the response that introduces their session ID. */
export class AcpSessionNewOrdering {
  private readonly knownSessionIds = new Set<string>();
  private readonly pendingSessionUpdates = new Map<string, AnyMessage[]>();

  observeInbound(message: AnyMessage): void {
    const sessionId = readSessionId(readObject(message)?.params);
    if (sessionId) {
      this.knownSessionIds.add(sessionId);
    }
  }

  transformOutbound(
    message: AnyMessage,
    controller: TransformStreamDefaultController<AnyMessage>,
  ): void {
    const sessionIdFromResult = readSessionId(readObject(message)?.result);
    if (sessionIdFromResult) {
      controller.enqueue(message);
      this.knownSessionIds.add(sessionIdFromResult);
      this.flushSessionUpdates(sessionIdFromResult, controller);
      return;
    }

    const messageObject = readObject(message);
    const sessionId = readSessionId(messageObject?.params);
    if (
      messageObject?.method === "session/update" &&
      sessionId &&
      !this.knownSessionIds.has(sessionId)
    ) {
      const pending = this.pendingSessionUpdates.get(sessionId) ?? [];
      pending.push(message);
      this.pendingSessionUpdates.set(sessionId, pending);
      return;
    }

    controller.enqueue(message);
  }

  private flushSessionUpdates(
    sessionId: string,
    controller: TransformStreamDefaultController<AnyMessage>,
  ): void {
    const pending = this.pendingSessionUpdates.get(sessionId);
    if (!pending) {
      return;
    }
    this.pendingSessionUpdates.delete(sessionId);
    for (const message of pending) {
      controller.enqueue(message);
    }
  }
}

function readObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function readSessionId(value: unknown): string | undefined {
  const sessionId = readObject(value)?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}
