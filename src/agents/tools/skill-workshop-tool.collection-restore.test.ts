import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applySkillProposal, proposeCreateSkill } from "../../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool as createSkillWorkshopToolImpl } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
const cleanups: Array<() => Promise<void>> = [];
const createSkillWorkshopTool = (
  options: Omit<Parameters<typeof createSkillWorkshopToolImpl>[0], "config" | "agentId"> & {
    config?: OpenClawConfig;
    agentId?: string;
  },
) => createSkillWorkshopToolImpl({ config: {}, agentId: "main", ...options });

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  await tempDirs.cleanup();
});

describe("skill_workshop collection restore", () => {
  it("restores a canonical cleanup into the Workshop directory", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-restore-state-",
    });
    cleanups.push(async () => await testState.cleanup());
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-skill-collection-restore-"),
    );
    const proposal = await proposeCreateSkill({
      workspaceDir,
      env: testState.env,
      agentId: "main",
      config: {},
      name: "duplicate",
      description: "Duplicate procedure",
      content: "# Duplicate procedure\n",
    });
    await applySkillProposal({
      workspaceDir,
      env: testState.env,
      agentId: "main",
      config: {},
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
    const reviewTool = createSkillWorkshopTool({
      workspaceDir,
      env: testState.env,
      collectionReconcile: { approvedSkillNames: new Set(["duplicate"]) },
    });
    await reviewTool.execute("read", { action: "read", skill_name: "duplicate" });
    const reconciled = await reviewTool.execute("reconcile", {
      action: "reconcile",
      collection: [{ action: "drop", name: "duplicate", reason: "redundant" }],
    });
    const backupId = (reconciled.details as { backupId: string }).backupId;
    const workshopSkillFile = path.join(
      resolveWorkshopSkillsDir({}, "main", testState.env),
      "duplicate",
      "SKILL.md",
    );
    await expect(fs.access(workshopSkillFile)).rejects.toThrow();

    const foregroundTool = createSkillWorkshopTool({ workspaceDir, env: testState.env });
    const restored = await foregroundTool.execute("restore", { action: "restore_collection" });
    expect(restored).toMatchObject({
      content: [
        {
          type: "text",
          text: `Restored skill collection backup ${backupId}: restored 1, removed 0.`,
        },
      ],
      details: { backupId, restored: ["duplicate"], removed: [] },
    });

    await expect(fs.readFile(workshopSkillFile, "utf8")).resolves.toContain("Duplicate procedure");
  });
});
