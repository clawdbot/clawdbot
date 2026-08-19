import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { buildPayloads } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads delivery recovery", () => {
  it("uses persisted delivery facts for a recovered final assistant", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Recovered answer" }],
        openclawDelivery: {
          audioAsVoice: true,
          replyToCurrent: true,
          replyToId: "message-7",
          tts: {
            tagged: true,
            text: "Recovered speech",
          },
        },
      } as AssistantMessage,
    });

    expect(payloads).toEqual([
      expect.objectContaining({
        text: "Recovered answer",
        audioAsVoice: true,
        replyToCurrent: true,
        replyToId: "message-7",
      }),
    ]);
    expect(getReplyPayloadMetadata(payloads[0]!)?.tts).toEqual({
      tagged: true,
      text: "Recovered speech",
    });
  });

  it("does not recover delivery facts by parsing a pre-upgrade assistant", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "[[reply_to:message-7]] Recovered answer" }],
      } as AssistantMessage,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Recovered answer");
    expect(payloads[0]).not.toHaveProperty("replyToCurrent");
    expect(payloads[0]).not.toHaveProperty("replyToId");
  });
});
