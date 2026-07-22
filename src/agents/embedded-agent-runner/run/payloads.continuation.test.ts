import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { extractContinuationSignal } from "../../../auto-reply/continuation/signal.js";
import { buildPayloads } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads continuation extraction", () => {
  it("preserves final-answer item boundaries", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Done.\nCONTINUE_WORK",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final_1",
              phase: "final_answer",
            }),
          },
          {
            type: "text",
            text: "Warning: cleanup remains.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final_2",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    const continuation = extractContinuationSignal({ payloads, enabled: true });

    expect(continuation.signal).toEqual({ kind: "work" });
    expect(payloads.map((payload) => payload.text)).toEqual(["Done.", "Warning: cleanup remains."]);
  });

  it("preserves leading whitespace in later final-answer items", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Done.\nCONTINUE_WORK",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final_1",
              phase: "final_answer",
            }),
          },
          {
            type: "text",
            text: "    indented code",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final_2",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expect(extractContinuationSignal({ payloads, enabled: true }).signal).toEqual({
      kind: "work",
    });
    expect(payloads.map((payload) => payload.text)).toEqual(["Done.", "    indented code"]);
  });
});
