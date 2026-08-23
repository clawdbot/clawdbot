// Skill contract tests cover full and compact catalog serialization.
import { formatSkillsForPrompt as upstreamFormatSkillsForPrompt } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import {
  formatSkillsForPromptCore,
  resolveSkillDisplayName,
  type Skill,
  formatSkillsCompactForPrompt as formatSkillsCompact,
} from "./skill-contract.js";

function makeSkill(name: string, desc = "A skill", filePath = `/skills/${name}/SKILL.md`): Skill {
  return createCanonicalFixtureSkill({
    name,
    description: desc,
    filePath,
    baseDir: `/skills/${name}`,
    source: "workspace",
  });
}

describe("resolveSkillDisplayName", () => {
  it("uses the first Markdown H1 after frontmatter", () => {
    expect(
      resolveSkillDisplayName(
        `---\nname: auto-review\ndescription: Review code.\n---\n# Auto Review\n`,
        "auto-review",
      ),
    ).toBe("Auto Review");
  });

  it("humanizes the identifier when the skill has no H1", () => {
    expect(resolveSkillDisplayName("Skill body without a title.\n", "patrick-daily_brief")).toBe(
      "Patrick Daily Brief",
    );
  });
});

describe("formatSkillsCompact", () => {
  it("keeps the full-format XML output aligned with the upstream formatter for visible skills", () => {
    const skills = [
      makeSkill("notes", "Summarize notes", "/tmp/notes/SKILL.md"),
      { ...makeSkill("weather", "Get weather <data> & forecasts"), promptVersion: "sha256:abc123" },
    ];
    const out = formatSkillsForPromptCore(skills);
    expect(out).toBe(upstreamFormatSkillsForPrompt(skills));
    expect(out).not.toContain("<version>");
  });

  it("renders all passed skills in the full formatter without reapplying visibility policy", () => {
    const hidden: Skill = { ...makeSkill("hidden"), disableModelInvocation: true };
    const out = formatSkillsForPromptCore([makeSkill("visible"), hidden]);
    expect(out).toContain("visible");
    expect(out).toContain("hidden");
  });

  it("returns empty string for no skills", () => {
    expect(formatSkillsCompact([])).toBe("");
  });

  it("keeps compact descriptions with name and location", () => {
    const skill = {
      ...makeSkill("weather", "Get weather data"),
      promptVersion: "sha256:abc123",
    };
    const out = formatSkillsCompact([skill]);
    expect(out).toContain("<name>weather</name>");
    expect(out).toContain("<description>Get weather data</description>");
    expect(out).toContain("<location>/skills/weather/SKILL.md</location>");
    expect(out).not.toContain("<version>");
  });

  it("omits descriptions when their compact budget is zero", () => {
    const out = formatSkillsCompact([makeSkill("weather", "Get weather data")], {
      descriptionMaxChars: 0,
    });
    expect(out).toContain("<name>weather</name>");
    expect(out).not.toContain("<description>");
  });

  it("preserves location notes when compact descriptions are omitted", () => {
    const out = formatSkillsCompact(
      [
        {
          ...makeSkill("remote", "Remote skill"),
          locationNote: "Load with exec host=node node=node-1.",
        },
      ],
      { descriptionMaxChars: 0 },
    );

    expect(out).toContain("<location_note>Load with exec host=node node=node-1.</location_note>");
  });

  it("truncates descriptions without splitting emoji surrogate pairs", () => {
    const out = formatSkillsCompact([makeSkill("emoji", `${"A".repeat(16)}😀 trailing`)], {
      descriptionMaxChars: 20,
    });

    expect(out).toContain(`<description>${"A".repeat(16)}...</description>`);
    expect(out).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("renders all passed skills without reapplying visibility policy", () => {
    const hidden: Skill = { ...makeSkill("hidden"), disableModelInvocation: true };
    const out = formatSkillsCompact([makeSkill("visible"), hidden]);
    expect(out).toContain("visible");
    expect(out).toContain("hidden");
  });

  it("escapes XML special characters", () => {
    const out = formatSkillsCompact([makeSkill("a<b&c")]);
    expect(out).toContain("a&lt;b&amp;c");
  });

  it("is significantly smaller than full format", () => {
    const skills = Array.from({ length: 50 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const compact = formatSkillsCompact(skills);
    expect(compact.length).toBeLessThan(formatSkillsForPromptCore(skills).length / 2);
  });
});
