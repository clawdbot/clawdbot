import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { seedLegacyCollectionBackup } from "../../skills/workshop/collection-backup.test-support.js";
import { resolveSkillCollectionBackupRoot } from "../../skills/workshop/collection-paths.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
const config: OpenClawConfig = {
  skills: { workshop: { autonomous: { mode: "auto" } } },
};

describe("skill_workshop collection restore", () => {
  it("restores a retained v2 backup through restore_collection", async () => {
    const testState = await createOpenClawTestState({ layout: "state-only" });
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-restore-");
    const skillsRoot = resolveWorkshopSkillsDir(config, "main", testState.env);
    const skillFile = path.join(skillsRoot, "duplicate", "SKILL.md");
    try {
      await fs.mkdir(path.dirname(skillFile), { recursive: true });
      await fs.writeFile(
        skillFile,
        "---\nname: duplicate\ndescription: Original\n---\n\n# Original\n",
      );
      await seedLegacyCollectionBackup(
        skillsRoot,
        resolveSkillCollectionBackupRoot(config, "main", testState.env),
        async () => {
          await fs.writeFile(skillFile, "---\nname: duplicate\ndescription: New\n---\n\n# New\n");
        },
      );

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
