import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditHandlers, testApi } from "./audit.js";

const listAuditEvents = vi.hoisted(() => vi.fn());

vi.mock("../../audit/audit-event-store.js", () => ({ listAuditEvents }));

const accountRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;

async function runAuditHandler(method: "audit.activity.list" | "audit.list", params: object) {
  const respond = vi.fn();
  await expectDefined(
    auditHandlers[method],
    "auditHandlers[method] test invariant",
  )({ params, respond } as never);
  return respond;
}

describe("audit gateway methods", () => {
  beforeEach(() => {
    listAuditEvents.mockReset();
    listAuditEvents.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          eventId: "event-1",
          sequence: 10,
          sourceSequence: 2,
          occurredAt: 100,
          kind: "agent_run",
          action: "agent.run.finished",
          status: "succeeded",
          actorType: "agent",
          actorId: "main",
          agentId: "main",
          runId: "run-1",
          redaction: "metadata_only",
        },
      ],
      nextCursor: 10,
    });
  });

  it("preserves the exact shipped audit.list request and result shape", async () => {
    const respond = await runAuditHandler("audit.list", {
      agentId: "main",
      kind: "agent_run",
      after: 50,
      before: 150,
      limit: 25,
      cursor: "11",
    });

    expect(listAuditEvents).toHaveBeenCalledWith({
      limit: 25,
      cursor: 11,
      filters: { agentId: "main", kind: "agent_run", after: 50, before: 150 },
    });
    expect(respond).toHaveBeenCalledWith(true, {
      events: [
        {
          eventId: "event-1",
          sequence: 10,
          sourceSequence: 2,
          occurredAt: 100,
          kind: "agent_run",
          action: "agent.run.finished",
          status: "succeeded",
          actor: { type: "agent", id: "main" },
          agentId: "main",
          runId: "run-1",
          redaction: "metadata_only",
        },
      ],
      nextCursor: "10",
    });
  });

  it("keeps message filters invalid on the shipped audit.list method", async () => {
    const respond = await runAuditHandler("audit.list", { kind: "message" });

    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(listAuditEvents).not.toHaveBeenCalled();
  });

  it("returns versioned message activity without synthetic run provenance", async () => {
    listAuditEvents.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          eventId: "event-message-1",
          sequence: 11,
          sourceSequence: 3,
          occurredAt: 101,
          kind: "message",
          action: "message.outbound.finished",
          status: "succeeded",
          actorType: "system",
          actorId: "gateway",
          direction: "outbound",
          channel: "telegram",
          conversationKind: "direct",
          outcome: "sent",
          deliveryKind: "text",
          durationMs: 12,
          resultCount: 1,
          accountRef,
          targetRef: accountRef,
          redaction: "metadata_only",
        },
      ],
    });

    const respond = await runAuditHandler("audit.activity.list", {
      kind: "message",
      direction: "outbound",
      channel: "telegram",
    });

    expect(listAuditEvents).toHaveBeenCalledWith({
      limit: 100,
      filters: {
        includeMessages: true,
        kind: "message",
        direction: "outbound",
        channel: "telegram",
      },
    });
    expect(respond).toHaveBeenCalledWith(true, {
      events: [
        {
          eventType: "outbound_message",
          schemaVersion: 1,
          eventId: "event-message-1",
          sequence: 11,
          sourceSequence: 3,
          occurredAt: 101,
          kind: "message",
          action: "message.outbound.finished",
          direction: "outbound",
          status: "succeeded",
          actor: { type: "system", id: "gateway" },
          channel: "telegram",
          conversationKind: "direct",
          outcome: "sent",
          deliveryKind: "text",
          durationMs: 12,
          resultCount: 1,
          accountRef,
          targetRef: accountRef,
          redaction: "metadata_only",
        },
      ],
    });
    const result = respond.mock.calls[0]?.[1] as { events?: Array<Record<string, unknown>> };
    expect(result.events?.[0]).not.toHaveProperty("agentId");
    expect(result.events?.[0]).not.toHaveProperty("runId");
  });

  it("projects a store-validated channel-sender identity", () => {
    expect(
      testApi.mapAuditActivityEvent({
        schemaVersion: 1,
        eventId: "event-message-2",
        sequence: 12,
        sourceSequence: 4,
        occurredAt: 102,
        kind: "message",
        action: "message.inbound.processed",
        status: "succeeded",
        actorType: "channel_sender",
        actorId: accountRef,
        direction: "inbound",
        channel: "telegram",
        conversationKind: "direct",
        outcome: "completed",
        redaction: "metadata_only",
      }),
    ).toMatchObject({
      eventType: "inbound_message",
      actor: { type: "channel_sender", id: accountRef },
    });
  });

  it.each(["audit.list", "audit.activity.list"] as const)(
    "rejects malformed cursors and inverted ranges for %s",
    async (method) => {
      expect(await runAuditHandler(method, { cursor: "bad" })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.any(Object),
      );
      expect(await runAuditHandler(method, { after: 2, before: 1 })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.any(Object),
      );
      expect(listAuditEvents).not.toHaveBeenCalled();
    },
  );

  it.each(["audit.list", "audit.activity.list"] as const)(
    "trims whitespace around cursor digits for %s",
    async (method) => {
      const respond = await runAuditHandler(method, { cursor: "  11  " });
      expect(respond).toHaveBeenCalledWith(true, expect.anything());
      expect(listAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ cursor: 11 }));
    },
  );
});
