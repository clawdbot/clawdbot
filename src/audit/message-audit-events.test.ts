import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitTrustedMessageAuditEvent,
  hasTrustedMessageAuditListeners,
  onTrustedMessageAuditEvent,
  resetMessageAuditEventsForTest,
} from "./message-audit-events.js";

const event = {
  occurredAt: 1,
  kind: "message",
  action: "message.inbound.processed",
  status: "succeeded",
  actorType: "system",
  actorId: "gateway",
  direction: "inbound",
  channel: "test",
  conversationKind: "direct",
  outcome: "completed",
} as const;

describe("trusted message audit events", () => {
  afterEach(() => {
    resetMessageAuditEventsForTest();
  });

  it("isolates a throwing listener and continues notifying later listeners", () => {
    const laterListener = vi.fn();
    onTrustedMessageAuditEvent(() => {
      throw new Error("listener failed");
    });
    onTrustedMessageAuditEvent(laterListener);

    expect(() => emitTrustedMessageAuditEvent(event)).not.toThrow();
    expect(laterListener).toHaveBeenCalledOnce();
  });

  it("tracks listeners and forwards producer metadata without durable identity work", () => {
    const listener = vi.fn();
    const unsubscribe = onTrustedMessageAuditEvent(listener);

    expect(hasTrustedMessageAuditListeners()).toBe(true);
    emitTrustedMessageAuditEvent({ ...event, sourceId: " message:stable " });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: " message:stable ",
      }),
    );
    expect(listener.mock.calls[0]?.[0]).not.toHaveProperty("sourceSequence");

    unsubscribe();
    expect(hasTrustedMessageAuditListeners()).toBe(false);
  });

  it("reset clears listeners", () => {
    const listener = vi.fn();
    onTrustedMessageAuditEvent(listener);
    emitTrustedMessageAuditEvent(event);
    resetMessageAuditEventsForTest();

    expect(hasTrustedMessageAuditListeners()).toBe(false);
    onTrustedMessageAuditEvent(listener);
    emitTrustedMessageAuditEvent(event);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
