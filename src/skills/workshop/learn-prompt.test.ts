// Tests the pure /learn Skill Workshop prompt builder.
import { describe, expect, it } from "vitest";
import { buildLearnPrompt, DEFAULT_LEARN_REQUEST } from "./learn-prompt.js";

describe("buildLearnPrompt", () => {
  it("preserves mixed source requirements and defaults blank input", () => {
    const prompt = buildLearnPrompt("Use docs/a.md and https://example.com; focus on recovery");

    expect(prompt).toContain("docs/a.md and https://example.com; focus on recovery");
    expect(prompt).toContain("SOURCES and REQUIREMENTS");
    expect(prompt).toContain("never fetch only the first source");
    expect(prompt).toContain(
      "update the best Workshop-generated skill before creating anything new",
    );
    expect(prompt).toContain("no durable reusable procedure");
    expect(prompt).not.toContain("NEVER capture");
    expect(buildLearnPrompt(" ")).toContain(DEFAULT_LEARN_REQUEST);
  });
});
