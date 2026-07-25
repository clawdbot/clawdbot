import { describe, expect, it } from "vitest";
import type { AuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";
import { createAuditEventRecorder } from "./audit-recorder.js";
import { emitTrustedMessageAuditEvent } from "./message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "./message-audit-events.test-support.js";

function captureWriter(inputs: AuditEventInput[]): AuditEventWriter {
  return {
    ready: Promise.resolve(),
    record: (input) => {
      inputs.push(input);
      return true;
    },
    stop: async () => {},
  };
}

function emitMessage(conversationKind: "direct" | "group") {
  emitTrustedMessageAuditEvent({
    occurredAt: 1,
    kind: "message",
    action: "message.inbound.processed",
    status: "succeeded",
    actorType: "channel_sender",
    actorId: "sender-raw",
    direction: "inbound",
    channel: "telegram",
    conversationKind,
    outcome: "completed",
  });
}

describe("message audit recorder", () => {
  it("keeps message events off by default policy", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAuditEventRecorder({
      messageMode: "off",
      writer: captureWriter(inputs),
    });
    const unsubscribe = onTrustedMessageAuditEvent(recorder.recordMessage);

    emitMessage("direct");

    unsubscribe();
    await recorder.stop();
    expect(inputs).toEqual([]);
  });

  it("records only known direct conversations in direct mode", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAuditEventRecorder({
      messageMode: "direct",
      writer: captureWriter(inputs),
    });
    const unsubscribe = onTrustedMessageAuditEvent(recorder.recordMessage);

    emitMessage("group");
    emitMessage("direct");

    unsubscribe();
    await recorder.stop();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "message",
      conversationKind: "direct",
      sourceId: expect.stringMatching(/^message:/u),
      sourceSequence: 1,
    });
  });

  it("records group metadata only in all mode", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAuditEventRecorder({
      messageMode: "all",
      writer: captureWriter(inputs),
    });
    const unsubscribe = onTrustedMessageAuditEvent(recorder.recordMessage);

    emitMessage("group");

    unsubscribe();
    await recorder.stop();
    expect(inputs[0]).toMatchObject({ kind: "message", conversationKind: "group" });
  });
});
