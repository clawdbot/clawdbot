import { describe, expect, it } from "vitest";
import { getSkillInstallRequirements, validateSkillManifest } from "./skill-manifest.js";

describe("skill manifest", () => {
  const manifest = {
    id: "github-pr-reviewer",
    name: "GitHub PR Reviewer",
    version: "1.0.0",
    capabilities: ["code-review"],
    connectors: ["github"],
    permissions: ["github.read_repository"],
    dependencies: ["git"],
  };

  it("validates required fields", () => {
    expect(validateSkillManifest(manifest)).toEqual([]);
  });

  it("exposes installation requirements", () => {
    expect(getSkillInstallRequirements(manifest)).toEqual({
      permissions: ["github.read_repository"],
      connectors: ["github"],
      dependencies: ["git"],
    });
  });
});
