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

    expect(result.promptText).toContain("Current user request:\nnewest inbound message");
    expect(result.promptText).toContain("[user]\nolder structured context\n[image omitted]");
    expect(result.promptText).toContain("[assistant]\nack");
    expect(result.promptText).not.toContain("[user]\nnewest inbound message");
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

    expect(result.promptText).toContain("[user]\n[image omitted]");
    expect(result.promptText).not.toContain("data:image/png");
    expect(result.promptText).not.toContain("bbbb");
  });
});
