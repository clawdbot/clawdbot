import { describe, expect, it } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../channels/message/receipt.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import {
  projectEmbeddedMessageDeliveryFact,
  readEmbeddedMessageDeliveryFact,
} from "./embedded-agent-message-delivery.js";

describe("projectEmbeddedMessageDeliveryFact", () => {
  it.each([
    { status: "settled", partialDelivery: false, sourceReplyDelivered: true, expected: true },
    { status: "settled", partialDelivery: true, sourceReplyDelivered: true },
    { status: "dryRun", partialDelivery: false, sourceReplyDelivered: true },
    { status: "failed", partialDelivery: false, sourceReplyDelivered: true },
    { status: "settled", partialDelivery: false, sourceReplyDelivered: "true" },
  ])("reads only confirmed final source delivery: %j", ({ expected, ...fact }) => {
    expect(
      readEmbeddedMessageDeliveryFact({ ...fact, createdThreadIds: [] })?.sourceReplyDelivered,
    ).toBe(expected);
  });
  it("projects canonical poll receipt identity and thread facts", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ messageId: "platform-poll-1" }],
      kind: "poll",
      threadId: "thread-1",
      sentAt: 1,
    });
    const result = {
      kind: "poll",
      channel: "discord",
      action: "poll",
      to: "channel:parent-1",
      handledBy: "core",
      payload: {},
      pollResult: {
        channel: "discord",
        to: "channel:parent-1",
        question: "Ship it?",
        options: ["Yes", "No"],
        maxSelections: 1,
        durationSeconds: null,
        durationHours: 24,
        via: "direct",
        result: { messageId: "legacy-poll-1", receipt },
      },
      dryRun: false,
    } satisfies MessageActionResult;

    expect(projectEmbeddedMessageDeliveryFact(result)).toEqual({
      status: "settled",
      primaryPlatformMessageId: "platform-poll-1",
      partialDelivery: false,
      createdThreadIds: ["thread-1"],
    });
  });
});
