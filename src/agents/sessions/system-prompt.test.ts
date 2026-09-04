import { describe, expect, it, vi } from "vitest";
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

  it.each(["default", "custom"] as const)(
    "appends the same ordered project suffix to the %s prompt without a read tool",
    (mode) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 4, 12));
      try {
        const prompt = buildSystemPrompt({
          cwd: "C:\\project\\workspace",
          customPrompt: mode === "custom" ? "Custom replacement prompt" : undefined,
          selectedTools: [],
          appendSystemPrompt: "Appended instructions",
          contextFiles: [{ path: "/project/AGENTS.md", content: "Project instructions" }],
          skills: [
            createCanonicalFixtureSkill({
              name: "hidden-skill",
              description: "Requires a read tool",
              filePath: "/skills/hidden-skill/SKILL.md",
              baseDir: "/skills/hidden-skill",
              source: "test",
            }),
          ],
        });
        const suffix = [
          "\n\nAppended instructions\n\n<project_context>\n",
          "Project-specific instructions and guidelines:\n",
          '<project_instructions path="/project/AGENTS.md">',
          "Project instructions",
          "</project_instructions>\n",
          "</project_context>\n",
          "Current date: 2026-09-04",
          "Current working directory: C:/project/workspace",
        ].join("\n");
        expect(prompt.endsWith(suffix)).toBe(true);
        expect(prompt.match(/<project_context>/g)).toHaveLength(1);
        expect(prompt).not.toContain("<available_skills>");
        if (mode === "custom") {
          expect(prompt).toBe(`Custom replacement prompt${suffix}`);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
