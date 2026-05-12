import { describe, expect, it } from "vitest";
import {
  STREAM_ERROR_FALLBACK_TEXT,
  buildStreamErrorAssistantMessage,
} from "./stream-message-shared.js";

const model = {
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  id: "anthropic.claude-3-haiku-20240307-v1:0",
};

describe("buildStreamErrorAssistantMessage", () => {
  it("never returns an empty content array", () => {
    const message = buildStreamErrorAssistantMessage({
      model,
      errorMessage: "stream aborted by upstream host=internal.example.com",
    });
    expect(message.content).toStrictEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
  });

  it("places only the sentinel in content and never echoes the raw error text", () => {
    const message = buildStreamErrorAssistantMessage({
      model,
      errorMessage: "stream aborted by upstream host=internal.example.com",
    });
    // Replay-visible content must be the canonical sentinel — replaying raw
    // provider error strings could leak hostnames/metadata to the model and
    // turn them into a prompt-injection surface.
    expect(message.content).toEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
    expect(JSON.stringify(message.content)).not.toContain("internal.example.com");
    // The detailed error remains available in the peer field for clients/UIs.
    expect(message.errorMessage).toBe("stream aborted by upstream host=internal.example.com");
    expect(message.stopReason).toBe("error");
  });

  it("uses the same sentinel when errorMessage is blank", () => {
    const message = buildStreamErrorAssistantMessage({ model, errorMessage: "   " });
    expect(message.content).toEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
    // Original errorMessage is preserved verbatim for clients that surface it.
    expect(message.errorMessage).toBe("   ");
  });
});
