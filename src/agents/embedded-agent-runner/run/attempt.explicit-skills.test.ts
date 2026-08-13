import { describe, expect, it } from "vitest";
import { renderExplicitSkillPrompt } from "./explicit-skill-prompt.js";

describe("renderExplicitSkillPrompt", () => {
  it("uses the canonical path outside a sandbox", () => {
    expect(
      renderExplicitSkillPrompt({
        prompt: "do the work",
        selections: [{ name: "example-manual", path: "/host/skill/SKILL.md" }],
        sandboxed: false,
        usagePaths: undefined,
      }),
    ).toContain("- example-manual: /host/skill/SKILL.md");
  });

  it("uses the mapped readable path inside a sandbox", () => {
    expect(
      renderExplicitSkillPrompt({
        prompt: "do the work",
        selections: [{ name: "example-manual", path: "/host/skill/SKILL.md" }],
        sandboxed: true,
        usagePaths: [
          {
            readPath: "/sandbox/skill/SKILL.md",
            skillFile: "/host/skill/SKILL.md",
            skillName: "example-manual",
            skillSource: "workspace",
          },
        ],
      }),
    ).toContain("- example-manual: /sandbox/skill/SKILL.md");
  });
});
