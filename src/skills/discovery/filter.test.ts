// Skill filter tests cover allowlist and agent-scoped skill selection behavior.
import { describe, expect, it } from "vitest";
import { isSessionSkillEnabled } from "./agent-filter.js";
import { matchesSkillFilter, normalizeSkillFilter } from "./filter.js";

const sessionSkillCases: Array<{
  name: string;
  skill: string;
  base: string[];
  overrides?: Record<string, boolean>;
  expected: boolean;
}> = [
  {
    name: "enables a skill outside the agent allowlist",
    skill: "release",
    base: ["github"],
    overrides: { release: true },
    expected: true,
  },
  {
    name: "disables a skill inside the agent allowlist",
    skill: "github",
    base: ["github"],
    overrides: { github: false },
    expected: false,
  },
  {
    name: "inherits the resolved agent filter when absent",
    skill: "github",
    base: ["github"],
    expected: true,
  },
];

describe("skills/filter", () => {
  it("normalizes configured filters with trimming", () => {
    expect(normalizeSkillFilter([" weather ", "", "meme-factory"])).toEqual([
      "weather",
      "meme-factory",
    ]);
  });

  it("preserves explicit empty list as []", () => {
    expect(normalizeSkillFilter([])).toStrictEqual([]);
    expect(normalizeSkillFilter(undefined)).toBeUndefined();
  });

  it("matches equivalent filters after normalization", () => {
    expect(matchesSkillFilter(["weather", "meme-factory"], [" meme-factory ", "weather"])).toBe(
      true,
    );
    expect(matchesSkillFilter(undefined, undefined)).toBe(true);
    expect(matchesSkillFilter([], undefined)).toBe(false);
  });

  it.each(sessionSkillCases)("$name", ({ skill, base, overrides, expected }) => {
    expect(isSessionSkillEnabled(skill, base, overrides)).toBe(expected);
  });
});
