import { describe, expect, it } from "vitest";
import { createSystemPromptOverride } from "./embedded-agent-runner.js";

describe("createSystemPromptOverride", () => {
  it("returns the override prompt trimmed", () => {
    const override = createSystemPromptOverride("OVERRIDE");
    expect(override()).toBe("OVERRIDE");
  });

  it("returns an empty string for blank overrides", () => {
    const override = createSystemPromptOverride("  \n  ");
    expect(override()).toBe("");
  });
});
