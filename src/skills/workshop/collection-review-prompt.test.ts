import path from "node:path";
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildCollectionReviewPrompt } from "./collection-review-prompt.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

describe("buildCollectionReviewPrompt", () => {
  it("bounds recorded usage rows and sorts them by use count", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-review-prompt-",
    });
    const skillsRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
    const skills = Array.from({ length: 201 }, (_, index) => ({
      name: index === 200 ? "x".repeat(200) : `skill-${index}`,
      filePath: path.join(skillsRoot, `skill-${index}`, "SKILL.md"),
    }));
    const lastUsedAtMs = Date.now() - 2 * 86_400_000;
    const database = openOpenClawStateDatabase({ env: testState.env });
    const insertUsage = database.db.prepare(
      `INSERT INTO skill_usage (
        skill_file, skill_key, skill_name, skill_source,
        first_used_at_ms, last_used_at_ms, use_count, last_agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, skill] of skills.entries()) {
      insertUsage.run(
        skill.filePath,
        skill.name,
        skill.name,
        "openclaw-workshop",
        lastUsedAtMs,
        lastUsedAtMs,
        index + 1,
        "main",
      );
    }

    try {
      const prompt = buildCollectionReviewPrompt(
        skills,
        skills.map((skill) => path.relative(skillsRoot, skill.filePath)),
        {},
        "main",
        testState.env,
      );
      const usageLines = prompt.split("\n").filter((line) => /^.+ \d+ \d+$/u.test(line));

      expect(prompt).toContain(`Workshop directory: ${skillsRoot}`);
      expect(prompt).toContain("Total skills: 201");
      expect(prompt).toContain("Full Workshop file index");
      expect(prompt).toContain('"skill-0/SKILL.md"');
      expect(prompt).toContain('"skill-200/SKILL.md"');
      expect(prompt).toContain(`${"x".repeat(80)} 201 2`);
      expect(prompt).toContain("skill-199 200 2");
      expect(prompt).not.toContain("skill-0 1 2");
      expect(prompt).toContain("Usage table truncated after 200 skills.");
      expect(usageLines).toHaveLength(200);
      expect(prompt).not.toContain("description");
    } finally {
      await testState.cleanup();
    }
  });
});
