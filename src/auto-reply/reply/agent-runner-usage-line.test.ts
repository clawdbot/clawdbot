import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendUsageLine } from "./agent-runner-usage-line.js";

describe("appendUsageLine", () => {
  it("preserves reply payload metadata when appending usage text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const [updated] = appendUsageLine([payload], "Usage: 12 in / 3 out");

    expect(updated).toEqual({ text: "message tool reply\nUsage: 12 in / 3 out" });
    expect(getReplyPayloadMetadata(updated)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:telegram:direct:123",
        idempotencyKey: "run-1:internal-source-reply:0",
        text: "message tool reply\nUsage: 12 in / 3 out",
      },
    });
  });
});
