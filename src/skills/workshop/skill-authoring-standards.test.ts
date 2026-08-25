import { describe, expect, it } from "vitest";
import { buildSkillExperienceReviewPrompt } from "./experience-review-prompt.js";
import { buildSkillHistoryScanPrompt } from "./history-scan-prompt.js";
import { buildLearnPrompt } from "./learn-prompt.js";
import { SKILL_AUTHORING_STANDARDS_PROMPT } from "./skill-authoring-standards.js";

describe("skill authoring standards", () => {
  it("defines the lean procedure standard", () => {
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("under 10,000 characters");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("Procedures, not records");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("first 60 characters");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("2–4 words");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("completion criterion");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("one source per meaning");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("never invent flags, commands, paths, APIs");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("never the failed attempts");
  });

  it("keeps review instructions in the tool description instead of the review prompt", () => {
    const learnPrompt = buildLearnPrompt("Capture the recovery procedure");
    const experienceReviewPrompt = buildSkillExperienceReviewPrompt({
      ctx: { runId: "run-1" },
    });
    const historyScanPrompt = buildSkillHistoryScanPrompt({ sessions: [] });

    for (const prompt of [learnPrompt, historyScanPrompt]) {
      expect(prompt).toContain(SKILL_AUTHORING_STANDARDS_PROMPT);
      expect(prompt.split(SKILL_AUTHORING_STANDARDS_PROMPT)).toHaveLength(2);
    }
    expect(experienceReviewPrompt).not.toContain(SKILL_AUTHORING_STANDARDS_PROMPT);
  });
});
