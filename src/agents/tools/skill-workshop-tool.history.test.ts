import { afterEach, describe, expect, it } from "vitest";
import { recordSkillCollectionReviewSuccess } from "../../skills/workshop/collection-review-state.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  await tempDirs.cleanup();
});

describe("skill_workshop collection history", () => {
  it("renders recent collection outcomes with drop reasons", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-history-state-",
    });
    cleanups.push(async () => await testState.cleanup());
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-history-");
    const tool = createSkillWorkshopTool({ workspaceDir, env: testState.env });

    await expect(tool.execute("empty-history", { action: "history" })).resolves.toMatchObject({
      content: [{ type: "text", text: "No recorded collection reviews." }],
      details: { reviews: [] },
    });

    const createTime = Date.UTC(2026, 7, 18, 12, 34, 56);
    recordSkillCollectionReviewSuccess(
      workspaceDir,
      createTime,
      {
        backupId: "backup-42",
        kept: ["deploy"],
        written: ["recover"],
        dropped: [{ name: "old-notes", reason: "merged into deploy" }],
      },
      { env: testState.env },
    );
    const review = {
      createTime: new Date(createTime).toISOString(),
      backupId: "backup-42",
      kept: ["deploy"],
      written: ["recover"],
      dropped: [{ name: "old-notes", reason: "merged into deploy" }],
    };

    await expect(tool.execute("history", { action: "history" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: `Recent collection reviews, newest first:\n${JSON.stringify(review)}`,
        },
      ],
      details: { reviews: [review] },
    });
  });

  it("keeps isolated collection reviews limited to read and reconcile", () => {
    const standardSchema = JSON.stringify(
      createSkillWorkshopTool({ workspaceDir: "/tmp/openclaw" }).parameters,
    );
    const restrictedSchema = JSON.stringify(
      createSkillWorkshopTool({
        workspaceDir: "/tmp/openclaw",
        collectionReconcile: { approvedSkillNames: new Set() },
      }).parameters,
    );

    expect(standardSchema).toContain('"history"');
    expect(restrictedSchema).toContain('"enum":["read","reconcile"]');
    expect(restrictedSchema).not.toContain('"history"');
  });
});
