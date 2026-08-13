import { describe, expect, it, vi } from "vitest";
import { resolveCodexSkillInputPlan } from "./explicit-skill-input.js";

describe("resolveCodexSkillInputPlan", () => {
  it("resolves an authorized selection to the enabled Codex catalog path", async () => {
    const request = vi.fn(async () => ({
      data: [
        {
          cwd: "/repo",
          skills: [
            {
              name: "example-manual",
              description: "Manual workflow",
              path: "/skills/example-manual/SKILL.md",
              scope: "repo",
              enabled: true,
            },
          ],
          errors: [],
        },
      ],
    }));

    await expect(
      resolveCodexSkillInputPlan({
        client: { request } as never,
        cwd: "/repo",
        selections: [{ name: "example-manual", path: "/skills/example-manual/SKILL.md" }],
        text: "Use $example-manual",
      }),
    ).resolves.toEqual({
      explicitSkillSelections: [
        { name: "example-manual", path: "/skills/example-manual/SKILL.md" },
      ],
      suppressedSkillNames: ["example-manual"],
    });
  });

  it("fails visibly instead of falling back to a disabled or mismatched skill", async () => {
    const request = vi.fn(async () => ({
      data: [{ cwd: "/repo", skills: [], errors: [] }],
    }));

    await expect(
      resolveCodexSkillInputPlan({
        client: { request } as never,
        cwd: "/repo",
        selections: [{ name: "example-manual", path: "/skills/example-manual/SKILL.md" }],
        text: "Use $example-manual",
      }),
    ).rejects.toThrow("Explicit skill is unavailable in the Codex harness: example-manual");
  });

  it("suppresses catalog skill names without suppressing app mentions", async () => {
    const request = vi.fn(async () => ({
      data: [
        {
          cwd: "/repo",
          skills: [
            {
              name: "native-skill",
              description: "Native skill",
              path: "/skills/native/SKILL.md",
              scope: "repo",
              enabled: true,
            },
          ],
          errors: [],
        },
      ],
    }));

    await expect(
      resolveCodexSkillInputPlan({
        client: { request } as never,
        cwd: "/repo",
        selections: [],
        text: "Use $native-skill with $figma",
      }),
    ).resolves.toEqual({
      explicitSkillSelections: [],
      suppressedSkillNames: ["native-skill"],
    });
  });
});
