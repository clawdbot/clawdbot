import { afterEach, describe, expect, it } from "vitest";
import { recordSkillCollectionReviewHistory } from "../../skills/workshop/collection-review-state.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool as createSkillWorkshopToolImpl } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
const cleanups: Array<() => Promise<void>> = [];

const createSkillWorkshopTool = (options: Parameters<typeof createSkillWorkshopToolImpl>[0]) =>
  createSkillWorkshopToolImpl({ config: {}, agentId: "main", ...options });

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
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: {},
      agentId: "main",
      env: testState.env,
    });

    await expect(tool.execute("empty-history", { action: "history" })).resolves.toMatchObject({
      content: [{ type: "text", text: "No recorded collection reviews." }],
      details: { reviews: [] },
    });

    const createTime = Date.UTC(2026, 7, 18, 12, 34, 56);
    recordSkillCollectionReviewHistory(
      "main",
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
      kept: { count: 1, names: ["deploy"] },
      written: { count: 1, names: ["recover"] },
      dropped: [{ name: "old-notes", reason: "merged into deploy" }],
    };

    await expect(tool.execute("history", { action: "history" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: `Recent collection reviews, newest first:\n${JSON.stringify(review)}`,
        },
      ],
      details: { reviews: [review], truncated: false },
    });
  });

  it("caps names and aggregate history output", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-history-caps-state-",
    });
    cleanups.push(async () => await testState.cleanup());
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-history-caps-");
    const names = (kind: string, review: number) =>
      Array.from(
        { length: 200 },
        (_, index) => `${kind}-${review}-${index}-long-enough-to-fill-the-history-budget`,
      );
    for (let review = 0; review < 20; review += 1) {
      recordSkillCollectionReviewHistory(
        "main",
        review,
        {
          backupId: `backup-${review}`,
          kept: names("kept", review),
          written: names("written", review),
          dropped: [{ name: `dropped-${review}`, reason: `reason-${review}` }],
        },
        { env: testState.env },
      );
    }

    const result = await createSkillWorkshopTool({
      workspaceDir,
      env: testState.env,
      modelContextWindowTokens: 200_000,
    }).execute("history", { action: "history" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const firstTenKept = names("kept", 19).slice(0, 10);

    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text).toContain(JSON.stringify({ count: 200, names: [...firstTenKept, "+190 more"] }));
    expect(text).toContain('"dropped":[{"name":"dropped-19","reason":"reason-19"}]');
    expect(text).toMatch(/\(history truncated\)$/u);
    expect(result.details).toMatchObject({
      truncated: true,
      reviews: expect.arrayContaining([
        expect.objectContaining({
          kept: { count: 200, names: [...firstTenKept, "+190 more"] },
          written: expect.objectContaining({ count: 200 }),
          dropped: [{ name: "dropped-19", reason: "reason-19" }],
        }),
      ]),
    });
    // The cap drops whole rows once the aggregate budget is exhausted.
    const boundedReviews = (result.details as { reviews: unknown[] }).reviews;
    expect(boundedReviews.length).toBeGreaterThan(0);
    expect(boundedReviews.length).toBeLessThan(20);

    const smallContextResult = await createSkillWorkshopTool({
      workspaceDir,
      env: testState.env,
      modelContextWindowTokens: 8_192,
    }).execute("history-small", { action: "history" });
    const smallContextText =
      smallContextResult.content[0]?.type === "text" ? smallContextResult.content[0].text : "";
    expect(smallContextText.length).toBeLessThanOrEqual(2_867);
    expect(smallContextText).toMatch(/\(history truncated\)$/u);
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
