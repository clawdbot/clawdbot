// Codex tests cover transcript repair runtime contract plugin behavior.
import {
  assistantHistoryMessage,
  currentPromptHistoryMessage,
  mediaOnlyHistoryMessage,
  structuredHistoryMessage,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";

describe("Codex transcript projection runtime contract", () => {
  it("drops only the duplicate trailing current prompt while preserving prior structured context", () => {
    const prompt = "newest inbound message";

    const result = projectContextEngineAssemblyForCodex({
      prompt,
      originalHistoryMessages: [structuredHistoryMessage()],
      assembledMessages: [
        structuredHistoryMessage(),
        assistantHistoryMessage(),
        currentPromptHistoryMessage(prompt),
      ],
    });

    expect(result.promptText).toBe("newest inbound message");
    expect(result.additionalContext).toContain("[user]\nolder structured context\n[image omitted]");
    expect(result.additionalContext).toContain("[assistant]\nack");
    expect(result.additionalContext).not.toContain("[user]\nnewest inbound message");
  });

  it("keeps media-only user history visible as omitted media instead of dropping the turn", () => {
    const result = projectContextEngineAssemblyForCodex({
      prompt: "newest inbound message",
      originalHistoryMessages: [mediaOnlyHistoryMessage()],
      assembledMessages: [
        mediaOnlyHistoryMessage(),
        currentPromptHistoryMessage("newest inbound message"),
      ],
    });

    expect(result.additionalContext).toContain("[user]\n[image omitted]");
    expect(result.additionalContext).not.toContain("data:image/png");
    expect(result.additionalContext).not.toContain("bbbb");
  });
});
