import { describe, expect, it } from "vitest";
import { extractAssistantText as extractChatHistoryAssistantText } from "./chat-history-text.js";
import { extractAssistantText as extractSessionAssistantText } from "./session-message-text.js";

function assistantTextPart(id: string, phase: string, text: string) {
  return {
    type: "text",
    text,
    textSignature: JSON.stringify({ v: 1, id, phase }),
  };
}

function assistantMessage(...content: ReturnType<typeof assistantTextPart>[]) {
  return {
    role: "assistant",
    content,
  };
}

const assistantTextExtractors = [
  ["chat history", extractChatHistoryAssistantText],
  ["session message", extractSessionAssistantText],
] as const;

describe("phase-aware assistant text helpers", () => {
  it("fails soft for malformed inputs", () => {
    for (const message of [null, 42, "broken history entry"]) {
      expect(extractChatHistoryAssistantText(message)).toBeUndefined();
      expect(extractSessionAssistantText(message)).toBeUndefined();
    }
  });

  for (const [label, extractAssistantText] of assistantTextExtractors) {
    it(`prefers final_answer text over commentary in ${label} helpers`, () => {
      const message = assistantMessage(
        assistantTextPart("commentary", "commentary", "Need verify healthy."),
        assistantTextPart("final", "final_answer", "Health check completed successfully."),
      );

      expect(extractAssistantText(message)).toBe("Health check completed successfully.");
    });

    it(`preserves spaces across split final_answer blocks in ${label} helpers`, () => {
      const message = assistantMessage(
        assistantTextPart("commentary", "commentary", "Need verify healthy."),
        assistantTextPart("final_1", "final_answer", "Hi "),
        assistantTextPart("final_2", "final_answer", "<think>secret</think>there"),
      );

      expect(extractAssistantText(message)).toBe("Hi there");
    });
  }

  it("does not fall back to commentary when an explicit final_answer is empty", () => {
    const message = assistantMessage(
      assistantTextPart("commentary", "commentary", "Need simpler use cat overwrite full file."),
      assistantTextPart("final", "final_answer", "   "),
    );

    expect(extractChatHistoryAssistantText(message)).toBeUndefined();
  });
});
