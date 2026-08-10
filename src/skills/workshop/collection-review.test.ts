import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSkillWorkshopTool } from "../../agents/tools/skill-workshop-tool.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import { runSkillCollectionReview } from "./collection-review.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-collection-review-state-",
  });
});

afterEach(async () => {
  runEmbeddedAgent.mockReset();
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill collection review", () => {
  it("runs an incognito session with only collection read and reconcile", async () => {
    const workspaceDir = await tempDirs.make("openclaw-collection-review-workspace-");
    await writeWorkspaceSkills(workspaceDir, [
      { name: "useful", description: "Useful reusable procedure" },
    ]);
    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        env: params.skillWorkshopProposalEnv,
        collectionReconcile: params.skillWorkshopCollectionReconcile,
      });
      await tool.execute("read", { action: "read", skill_name: "useful" });
      await tool.execute("reconcile", {
        action: "reconcile",
        collection: [{ action: "keep", name: "useful" }],
      });
      return {};
    });

    await expect(
      runSkillCollectionReview({
        agentId: "main",
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        workspaceDir,
        env: testState.env,
      }),
    ).resolves.toMatchObject({ kept: ["useful"], written: [], dropped: [] });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "cron",
        toolsAllow: ["skill_workshop"],
        disableMessageTool: true,
        disableTrajectory: true,
        skillWorkshopCollectionReconcile: expect.any(Object),
        skillsSnapshot: { prompt: "", skills: [] },
      }),
    );
  });
});
