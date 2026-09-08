import { describe, expect, it } from "vitest";
import { projectCopilotRequestFacts } from "./github-copilot-request-facts.js";

describe("Copilot request facts", () => {
  it.each([
    { role: "user", content: [{ type: "image" }], initiator: "user", hasImages: true },
    { role: "toolResult", content: [{ type: "image" }], initiator: "agent", hasImages: true },
    { role: "assistant", content: [{ type: "image" }], initiator: "agent", hasImages: false },
  ])("projects $role input in both content modes", ({ role, content, initiator, hasImages }) => {
    for (const mode of ["direct", "nested"] as const) {
      expect(projectCopilotRequestFacts([{ role, content }], mode)).toEqual({
        initiator,
        hasImages,
      });
    }
  });

  it("treats nested user tool results as continuation and vision only in nested mode", () => {
    const messages = [
      { role: "user", content: [{ type: "tool_result", content: [{ type: "image" }] }] },
    ];
    expect(projectCopilotRequestFacts(messages, "direct")).toEqual({
      initiator: "user",
      hasImages: false,
    });
    expect(projectCopilotRequestFacts(messages, "nested")).toEqual({
      initiator: "agent",
      hasImages: true,
    });
    expect(projectCopilotRequestFacts(messages, "nested", false)).toEqual({
      initiator: "agent",
      hasImages: false,
    });
  });
});
