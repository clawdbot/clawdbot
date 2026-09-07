import { describe, expect, it } from "vitest";
import { buildPromptPrefix } from "./prompt.js";
import { buildSearchQuery } from "./query.js";

describe("active-memory search queries", () => {
  it.each([
    [
      `what should I pack?\n\n${buildPromptPrefix("User prefers aisle seats.")}`,
      [],
      "what should I pack?",
    ],
    ["Context: my project uses TypeScript", [], "Context: my project uses TypeScript"],
    [
      "why?",
      [{ role: "user" as const, text: `${"x".repeat(119)}🚀tail` }],
      `${"x".repeat(119)} why?`,
    ],
  ])("builds a safe query from %#", (latestUserMessage, recentTurns, expected) => {
    const query = buildSearchQuery({ latestUserMessage, recentTurns });
    expect(query).toBe(expected);
    expect(query).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });
});
