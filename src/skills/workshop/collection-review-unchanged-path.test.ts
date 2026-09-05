import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CronStoredJob } from "../../cron/types.js";
import type { PluginHookSkillChangedEvent } from "../../plugins/hook-types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runSkillCollectionReviewForAgent } from "./collection-review.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

type ReviewChange = Pick<PluginHookSkillChangedEvent, "action">;

const dispatchCommittedSkillChangeBestEffort = vi.hoisted(() =>
  vi.fn(async (_change: ReviewChange) => {}),
);
const snapshotCommittedSkillArtifactBestEffort = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lifecycle/skill-change-hook.js", () => ({
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks: () => true,
  snapshotCommittedSkillArtifactBestEffort,
}));

describe("unchanged Workshop review paths", () => {
  it.each([
    { label: "hidden file", relativePath: ".hidden/notes.txt" },
    { label: "non-skill directory", relativePath: "node_modules/notes.txt" },
  ])("leaves an unchanged $label alone", async ({ relativePath }) => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-review-unchanged-path-",
    });
    const skillsRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
    const unchangedPath = path.join(skillsRoot, relativePath);
    try {
      await fs.mkdir(path.dirname(unchangedPath), { recursive: true });
      await fs.writeFile(unchangedPath, "keep\n");
      await writeSkill(skillsRoot, "procedure", "Procedure", "# Before\n");
      const result = await runSkillCollectionReviewForAgent({
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        agentId: "main",
        job: createReviewJob(`skill-review-unchanged-${relativePath}`),
        env: testState.env,
        runTurn: async () => {
          await fs.writeFile(
            path.join(skillsRoot, "procedure", "SKILL.md"),
            "---\nname: procedure\ndescription: Procedure\n---\n\n# After\n",
          );
          return { status: "ok", summary: "reviewed", outputText: "" };
        },
      });

      expect(result.status).toBe("ok");
      await expect(fs.readFile(unchangedPath, "utf8")).resolves.toBe("keep\n");
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
