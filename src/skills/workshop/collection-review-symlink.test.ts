import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CronStoredJob } from "../../cron/types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSkillReviewOutcomes } from "./collection-review-state.js";
import { runSkillCollectionReviewForAgent } from "./collection-review.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

describe("Skill Workshop review symbolic links", () => {
  it.each([1, 2])("removes %s created links while preserving a healthy edit", async (linkCount) => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-review-symlink-",
    });
    const skillsRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
    const targetPath = path.join(path.dirname(skillsRoot), "review-target.txt");
    const linkPath = path.join(skillsRoot, "procedure", "outside-link");
    const error =
      "Skill collection review completed with errors: review created a symbolic link at procedure/outside-link";
    try {
      await writeSkill(skillsRoot, "procedure", "Procedure", "# Procedure\n");
      await writeSkill(skillsRoot, "healthy", "Healthy procedure", "# Before\n");
      await fs.writeFile(targetPath, "target remains unchanged\n");
      const result = await runSkillCollectionReviewForAgent({
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        agentId: "main",
        job: createReviewJob("skill-review-symlink"),
        env: testState.env,
        runTurn: async () => {
          for (let index = 0; index < linkCount; index += 1) {
            await fs.symlink(targetPath, index === 0 ? linkPath : linkPath + "-2");
          }
          await writeSkill(skillsRoot, "healthy", "Healthy procedure", "# After\n");
          return { status: "ok", summary: "reviewed", outputText: "" };
        },
      });

      await expect(
        fs.readFile(path.join(skillsRoot, "healthy", "SKILL.md"), "utf8"),
      ).resolves.toContain("# After");
      expect(result).toMatchObject({ status: "error", error, summary: error });
      await expect(fs.lstat(linkPath)).rejects.toThrow();
      if (linkCount === 2) {
        await expect(fs.lstat(linkPath + "-2")).rejects.toThrow();
      }
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("target remains unchanged\n");
      expect(readSkillReviewOutcomes({ env: testState.env }).collectionReviews.main).toEqual(
        expect.objectContaining({ error }),
      );
    } finally {
      await testState.cleanup();
    }
  });
});

function createReviewJob(id: string): CronStoredJob {
  return {
    id,
    declarationKey: "skill-collection-review:main",
    name: "skill review",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    agentId: "main",
    schedule: { kind: "every", everyMs: 604_800_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "review" },
    state: {},
  } satisfies CronStoredJob;
}

async function writeSkill(
  skillsRoot: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const skillDir = path.join(skillsRoot, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
}
