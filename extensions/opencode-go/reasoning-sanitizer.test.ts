// Opencode Go tests cover reasoning sanitizer plugin behavior.
import { describe, expect, it } from "vitest";
import { stripOpencodeGoKimiReasoningPayload } from "./reasoning-sanitizer.js";

describe("OpenCode Go Kimi reasoning payload sanitizer", () => {
  it("strips unsupported replay reasoning fields from messages and input", () => {
    const payload = {
      model: "kimi-k2.6",
      reasoning_effort: "high",
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "done" },
            { type: "thinking", reasoning_details: [{ text: "private thought" }] },
            { type: "redacted_thinking", data: "opaque" },
          ],
          reasoning_details: [{ text: "private thought" }],
          reasoning_content: "private thought",
          reasoning_text: "private thought",
        },
      ],
      input: [
        {
          role: "assistant",
          content: "done",
          reasoning_details: [{ text: "private thought" }],
        },
        { type: "reasoning", summary: [] },
        {
          role: "assistant",
          content: [{ type: "thinking", reasoning_details: [{ text: "private thought" }] }],
        },
      ],
    };

    stripOpencodeGoKimiReasoningPayload(payload);

    expect(payload).toEqual({
      model: "kimi-k2.6",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      ],
      input: [
        {
          role: "assistant",
          content: "done",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "[assistant reasoning omitted]" }],
        },
      ],
    });
  });
});
