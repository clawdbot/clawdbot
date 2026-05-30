import { describe, expect, it } from "vitest";
import type { SessionSkillSnapshot } from "../../config/sessions/types.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { hydrateResolvedSkills, hydrateResolvedSkillsAsync } from "./snapshot-hydration.js";

function makeFixtureSkill(name: string, bodySize = 3000) {
  const source = `# ${name}\n\n${"x".repeat(bodySize)}`;
  return createCanonicalFixtureSkill({
    name,
    description: `${name} skill description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    source,
  });
}

describe("hydrateResolvedSkills", () => {
  it("returns the same snapshot when resolvedSkills is already populated", () => {
    const snapshot: SessionSkillSnapshot = {
      prompt: "p",
      skills: [{ name: "x" }],
      resolvedSkills: [makeFixtureSkill("x", 100)],
      version: 1,
    };
    let buildCalls = 0;
    const result = hydrateResolvedSkills(snapshot, () => {
      buildCalls += 1;
      return { prompt: "rebuilt", skills: [], resolvedSkills: [], version: 99 };
    });
    expect(result).toBe(snapshot);
    expect(buildCalls).toBe(0);
  });

  it("rebuilds resolvedSkills only when missing and preserves persisted fields", () => {
    const stripped: SessionSkillSnapshot = {
      prompt: "original-prompt",
      skills: [{ name: "x" }],
      skillFilter: ["x"],
      version: 7,
    };
    const rebuiltSkills = [makeFixtureSkill("x", 200)];
    let buildCalls = 0;
    const result = hydrateResolvedSkills(stripped, () => {
      buildCalls += 1;
      return {
        prompt: "DIFFERENT-PROMPT",
        skills: [{ name: "y" }],
        resolvedSkills: rebuiltSkills,
        version: 99,
      };
    });
    expect(buildCalls).toBe(1);
    expect(result.prompt).toBe("original-prompt");
    expect(result.skills).toEqual([{ name: "x" }]);
    expect(result.skillFilter).toEqual(["x"]);
    expect(result.version).toBe(7);
    expect(result.resolvedSkills).toBe(rebuiltSkills);
  });

  it("treats an empty resolvedSkills array as populated", () => {
    const snapshot: SessionSkillSnapshot = {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 1,
    };
    let buildCalls = 0;
    const result = hydrateResolvedSkills(snapshot, () => {
      buildCalls += 1;
      return { prompt: "", skills: [], resolvedSkills: [makeFixtureSkill("x")], version: 1 };
    });
    expect(result).toBe(snapshot);
    expect(buildCalls).toBe(0);
  });

  it("supports async runtime hydration for CLI resume paths", async () => {
    const stripped: SessionSkillSnapshot = {
      prompt: "cached-prompt",
      skills: [{ name: "x" }],
      version: 2,
    };
    const rebuiltSkills = [makeFixtureSkill("x", 120)];
    const result = await hydrateResolvedSkillsAsync(stripped, async () => ({
      prompt: "fresh-prompt",
      skills: [{ name: "y" }],
      resolvedSkills: rebuiltSkills,
      version: 3,
    }));
    expect(result.prompt).toBe("cached-prompt");
    expect(result.skills).toEqual([{ name: "x" }]);
    expect(result.version).toBe(2);
    expect(result.resolvedSkills).toBe(rebuiltSkills);
  });
});
