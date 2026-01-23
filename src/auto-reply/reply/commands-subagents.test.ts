import { describe, expect, it } from "vitest";

import { extractMessageText } from "./commands-subagents.js";

describe("extractMessageText", () => {
  it("preserves user text that looks like tool call markers", () => {
    const message = {
      role: "user",
      content: "Here [Tool Call: foo (ID: 1)] ok",
    };
    const result = extractMessageText(message);
    expect(result?.text).toContain("[Tool Call: foo (ID: 1)]");
  });

  it("sanitizes assistant tool call markers", () => {
    const message = {
      role: "assistant",
      content: "Here [Tool Call: foo (ID: 1)] ok",
    };
    const result = extractMessageText(message);
    expect(result?.text).toBe("Here ok");
  });
});
