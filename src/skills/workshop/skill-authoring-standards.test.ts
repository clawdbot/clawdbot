import { describe, expect, it } from "vitest";
import { buildSkillWorkshopToolDescription } from "../../agents/tools/skill-workshop-tool-description.js";
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
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain(
      "every step comes from the observed trajectory or the existing skill",
    );
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("never invent flags, commands, paths, APIs");
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain("never the failed attempts");
  });

  it("provides review authoring standards once through the Workshop tool", () => {
    const learnPrompt = buildLearnPrompt("Capture the recovery procedure");
    const experienceReviewPrompt = buildSkillExperienceReviewPrompt({});
    const historyScanPrompt = buildSkillHistoryScanPrompt({ sessions: [] });
    const toolDescription = buildSkillWorkshopToolDescription({
      autonomousMode: "off",
      proposalRevision: false,
    });

    expect(learnPrompt.split(SKILL_AUTHORING_STANDARDS_PROMPT)).toHaveLength(2);
    for (const prompt of [experienceReviewPrompt, historyScanPrompt]) {
      expect(prompt).not.toContain(SKILL_AUTHORING_STANDARDS_PROMPT);
      expect(`${toolDescription}\n${prompt}`.split(SKILL_AUTHORING_STANDARDS_PROMPT)).toHaveLength(
        2,
      );
    }
  });
});
