import { describe, expect, it, vi } from "vitest";
import {
  attachPublishedSandboxSkills,
  readPublishedSandboxSkills,
  releasePublishedSandboxSkillsOnThrow,
} from "./published-skills-handoff.js";

describe("releasePublishedSandboxSkillsOnThrow", () => {
  it("releases the attached catalog when work throws", async () => {
    const owner = {};
    const releaseGeneration = vi.fn();
    attachPublishedSandboxSkills(owner, {
      releaseGeneration,
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [] },
    });

    await expect(
      releasePublishedSandboxSkillsOnThrow(owner, async () => {
        throw new Error("preparation failed");
      }),
    ).rejects.toThrow(/preparation failed/);

    expect(releaseGeneration).toHaveBeenCalledOnce();
    expect(readPublishedSandboxSkills(owner)).toBeUndefined();
  });

  it("keeps the catalog when work returns", async () => {
    const owner = {};
    const releaseGeneration = vi.fn();
    attachPublishedSandboxSkills(owner, {
      releaseGeneration,
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [] },
    });

    await expect(releasePublishedSandboxSkillsOnThrow(owner, async () => "ok")).resolves.toBe("ok");

    expect(releaseGeneration).not.toHaveBeenCalled();
    expect(readPublishedSandboxSkills(owner)?.skillsSnapshot.skills).toEqual([]);
  });
});
