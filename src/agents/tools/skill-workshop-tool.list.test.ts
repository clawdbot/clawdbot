import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeWorkspaceSkills } from "../../skills/test-support/e2e-test-helpers.js";
import { withSkillCollectionLock } from "../../skills/workshop/target-lock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-list-state-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill_workshop list", () => {
  it.each([0, 1.5, "1.5", "25items", "many"])(
    "rejects invalid list limit %s before touching proposal state",
    async (limit) => {
      const workspaceDir = await tempDirs.make("openclaw-skill-workshop-list-");
      const tool = createSkillWorkshopTool({
        workspaceDir,
        config: {},
        agentId: "main",
        env: testState.env,
      });

      await expect(tool.execute("call-list-limit", { action: "list", limit })).rejects.toThrow(
        "limit must be a positive integer",
      );
      await expect(fs.access(path.join(testState.stateDir, "skill-workshop"))).rejects.toThrow();
    },
  );

  it("reconciles a full pending page while preserving list limits through 50", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-list-");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { maxPending: 200 } } },
      agentId: "main",
      env: testState.env,
    });

    for (let index = 0; index < 51; index += 1) {
      await tool.execute(`call-create-${index}`, {
        action: "create",
        name: `Limit Proposal ${index}`,
        description: `Proposal ${index}`,
        proposal_content: `# Limit Proposal ${index}\n`,
      });
    }
    await writeWorkspaceSkills(
      workspaceDir,
      Array.from({ length: 51 }, (_, index) => ({
        name: `limit-proposal-${index}`,
        description: `Materialized proposal ${index}`,
      })),
    );

    let releaseLock: (() => void) | undefined;
    let markAcquired: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const heldLock = withSkillCollectionLock(
      workspaceDir,
      async () => {
        markAcquired?.();
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      },
      { env: testState.env },
    );
    await acquired;
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const releaseTimer = setTimeout(() => releaseLock?.(), 4_600);

    try {
      for (const [limit, expectedCount] of [
        [49, 49],
        [50, 50],
        [51, 50],
      ] as const) {
        const result = await tool.execute(`call-list-${limit}`, { action: "list", limit });
        const proposals = (result.details as { proposals: Array<{ status: string }> }).proposals;
        expect(proposals).toHaveLength(expectedCount);
        expect(proposals.every((proposal) => proposal.status === "stale")).toBe(true);
      }

      await expect(
        tool.execute("call-list-last", {
          action: "list",
          query: "Limit Proposal 50",
          limit: 1,
        }),
      ).resolves.toMatchObject({
        details: { proposals: [expect.objectContaining({ status: "stale" })] },
      });
    } finally {
      clearTimeout(releaseTimer);
      releaseLock?.();
      await heldLock;
      randomSpy.mockRestore();
    }
  }, 15_000);
});
