import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../../cron/types.js";
import { runSkillCollectionReviewForAgent } from "../../skills/workshop/collection-review.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
const config: OpenClawConfig = {
  skills: { workshop: { autonomous: { mode: "auto" } } },
};

describe("skill_workshop collection restore", () => {
  it("restores the latest review through restore_collection", async () => {
    const testState = await createOpenClawTestState({ layout: "state-only" });
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-restore-");
    const skillsRoot = resolveWorkshopSkillsDir(config, "main", testState.env);
    const skillFile = path.join(skillsRoot, "duplicate", "SKILL.md");
    const job = {
      id: "skill-review",
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
    } satisfies CronJob;
    try {
      await fs.mkdir(path.dirname(skillFile), { recursive: true });
      await fs.writeFile(
        skillFile,
        "---\nname: duplicate\ndescription: Original\n---\n\n# Original\n",
      );
      await runSkillCollectionReviewForAgent({
        config,
        agentId: "main",
        job,
        env: testState.env,
        runTurn: async () => {
          await fs.writeFile(skillFile, "---\nname: duplicate\ndescription: New\n---\n\n# New\n");
          return { status: "ok", summary: "reviewed", outputText: "done" };
        },
      });

      const tool = createSkillWorkshopTool({
        workspaceDir,
        config,
        agentId: "main",
        env: testState.env,
      });
      await tool.execute("restore", { action: "restore_collection" });
      await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("# Original");
    } finally {
      await testState.cleanup();
      await tempDirs.cleanup();
    }
  });
});
