import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeWorkspaceSkills } from "../../skills/test-support/e2e-test-helpers.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  await tempDirs.cleanup();
});

describe("skill_workshop collection restore", () => {
  it("restores a canonical cleanup through the configured workspace alias", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-restore-state-",
    });
    cleanups.push(async () => await testState.cleanup());
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-restore-");
    await writeWorkspaceSkills(workspaceDir, [
      { name: "duplicate", description: "Duplicate procedure" },
    ]);
    const reviewTool = createSkillWorkshopTool({
      workspaceDir,
      env: testState.env,
      collectionReconcile: { approvedSkillNames: new Set(["duplicate"]) },
    });
    await reviewTool.execute("read", { action: "read", skill_name: "duplicate" });
    await reviewTool.execute("reconcile", {
      action: "reconcile",
      collection: [{ action: "drop", name: "duplicate", reason: "redundant" }],
    });
    const aliasParent = await tempDirs.make("openclaw-skill-collection-restore-alias-");
    const workspaceAlias = path.join(aliasParent, "workspace-alias");
    await fs.symlink(
      workspaceDir,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );

    const foregroundTool = createSkillWorkshopTool({
      workspaceDir: workspaceAlias,
      env: testState.env,
    });
    await foregroundTool.execute("restore", { action: "restore_collection" });

    await expect(
      fs.readFile(path.join(workspaceAlias, "skills", "duplicate", "SKILL.md"), "utf8"),
    ).resolves.toContain("Duplicate procedure");
  });
});
