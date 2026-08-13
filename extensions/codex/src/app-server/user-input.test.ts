import { describe, expect, it } from "vitest";
import { buildCodexUserInput, splitCodexTextSkillMentions } from "./user-input.js";

describe("buildCodexUserInput", () => {
  it("preserves visible text while preventing native text-only skill selection", () => {
    const text = "Use $example-manual, keep $HOME literal, and preserve $figma";
    const inputs = buildCodexUserInput(
      text,
      undefined,
      [{ name: "example-manual", path: "/skills/example-manual/SKILL.md" }],
      true,
      ["example-manual"],
    );

    expect(
      inputs
        .filter((input) => input.type === "text")
        .map((input) => input.text)
        .join(""),
    ).toBe(text);
    expect(inputs).toContainEqual({
      type: "skill",
      name: "example-manual",
      path: "/skills/example-manual/SKILL.md",
    });
    expect(
      inputs
        .filter((input) => input.type === "text")
        .some((input) => input.text.includes("$example-manual")),
    ).toBe(false);
    expect(
      inputs
        .filter((input) => input.type === "text")
        .some((input) => input.text.includes("$figma")),
    ).toBe(true);
  });

  it("bounds mention-shaped text fragmentation", () => {
    expect(() => splitCodexTextSkillMentions("$skill ".repeat(65), ["skill"])).toThrow(
      "more than 64 skill-shaped references",
    );
  });

  it("leaves Codex-ignored shell variables unsplit", () => {
    const text = "$HOME ".repeat(65);
    expect(splitCodexTextSkillMentions(text, ["HOME"])).toEqual([text]);
  });

  it("preserves native text mentions for supervised Codex turns", () => {
    expect(buildCodexUserInput("Use $native-skill", undefined, undefined, false)).toEqual([
      { type: "text", text: "Use $native-skill", text_elements: [] },
    ]);
  });

  it("preserves linked app mentions even when a skill shares the same name", () => {
    const text = "Use [$calendar](app://calendar)";
    expect(splitCodexTextSkillMentions(text, ["calendar"])).toEqual([text]);
  });
});
