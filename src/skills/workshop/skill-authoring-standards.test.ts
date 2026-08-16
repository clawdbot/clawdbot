import { describe, expect, it } from "vitest";
import { buildSkillExperienceReviewPrompt } from "./experience-review-prompt.js";
import { buildSkillHistoryScanPrompt } from "./history-scan-prompt.js";
import { buildLearnPrompt } from "./learn-prompt.js";
import { SKILL_AUTHORING_STANDARDS_PROMPT } from "./skill-authoring-standards.js";

describe("skill authoring standards", () => {
  it("defines routing, naming, body, token, evidence, and durable-fix requirements", () => {
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("first ~60 characters");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("one trigger per actual branch");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("notes, helpers, or workflows");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("class-level name");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("checkable completion criterion");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("direct pointer");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("one source for each meaning");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("Every sentence must earn its tokens");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("never invent flags");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("capture the working fix");
  });

  it("is included verbatim in learn, experience-review, and history-scan prompts", () => {
    const prompts = [
      buildLearnPrompt("Capture the recovery procedure"),
      buildSkillExperienceReviewPrompt({
        ctx: { runId: "run-1" },
        transcript: "[user]\nFix it\n\n[assistant]\nRecovered.",
        modelIterations: 10,
      }),
      buildSkillHistoryScanPrompt({ sessions: [] }),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain(SKILL_AUTHORING_STANDARDS_PROMPT);
      expect(prompt.split(SKILL_AUTHORING_STANDARDS_PROMPT)).toHaveLength(2);
    }
  });
});
