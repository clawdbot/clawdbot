import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { buildSystemPrompt } from "./system-prompt.js";

describe("buildSystemPrompt", () => {
  it("includes promised-work policy in the default prompt only", () => {
    const prompt = buildSystemPrompt({ cwd: "/tmp/workspace" });

    expect(prompt).toContain("## Promised Work");
    expect(prompt).toContain("Progress such as `running` is not completion.");
    expect(prompt.match(/## Promised Work/g)).toHaveLength(1);

    expect(
      buildSystemPrompt({
        cwd: "/tmp/workspace",
        customPrompt: "Custom replacement prompt",
      }),
    ).not.toContain("## Promised Work");
  });

  it("bounds and deterministically orders the embedded skills catalog", () => {
    const skills = Array.from({ length: 200 }, (_, index) => {
      const name = `skill-${String(199 - index).padStart(3, "0")}`;
      return createCanonicalFixtureSkill({
        name,
        description: "x".repeat(1_024),
        filePath: `/skills/${name}/SKILL.md`,
        baseDir: `/skills/${name}`,
        source: "test",
      });
    });

    const prompt = buildSystemPrompt({
      cwd: "/tmp/workspace",
      customPrompt: "Custom replacement prompt",
      skills,
    });
    const skillsPrompt = prompt.slice(
      "Custom replacement prompt".length,
      prompt.indexOf("\nCurrent date:"),
    );
    const renderedNames = [...skillsPrompt.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => {
      const name = match[1];
      if (!name) {
        throw new Error("expected a rendered skill name");
      }
      return name;
    });

    expect(skillsPrompt.length).toBeLessThanOrEqual(18_000);
    expect(renderedNames.length).toBeLessThanOrEqual(150);
    expect(renderedNames.length).toBeGreaterThan(0);
    expect(renderedNames).toEqual(renderedNames.toSorted((a, b) => a.localeCompare(b, "en")));
    expect(skillsPrompt).toContain("⚠️ Skills truncated:");
  });
});
