import type { AnyMessage } from "@agentclientprotocol/sdk";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Keeps initial session updates behind the response that introduces their session ID. */
export class AcpSessionNewOrdering {
  private readonly knownSessionIds = new Set<string>();
  private readonly pendingSessionUpdates = new Map<string, AnyMessage[]>();

  observeInbound(message: AnyMessage): void {
    const sessionId = readSessionId(asOptionalRecord(message)?.params);
    if (sessionId) {
      this.knownSessionIds.add(sessionId);
    }
  }

  transformOutbound(
    message: AnyMessage,
    controller: TransformStreamDefaultController<AnyMessage>,
  ): void {
    const sessionIdFromResult = readSessionId(asOptionalRecord(message)?.result);
    if (sessionIdFromResult) {
      controller.enqueue(message);
      this.knownSessionIds.add(sessionIdFromResult);
      this.flushSessionUpdates(sessionIdFromResult, controller);
      return;
    }

    const messageObject = asOptionalRecord(message);
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

function readSessionId(value: unknown): string | undefined {
  const sessionId = asOptionalRecord(value)?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}
